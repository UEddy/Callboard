import { useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  participants,
  authTokens,
  fieldDefinitions,
  formFields,
  forms,
  submissions,
  submissionParticipants,
  tasks,
  taskAssignments,
  tracks,
  rooms,
  events,
  emailTemplates,
  emailLog,
} from "~/db/schema";
import { readPortal, writePortal } from "~/lib/session";
import { render, sendEmail } from "~/lib/email";
import { ThemeToggle } from "~/components/ThemeToggle";
import { EventTime } from "~/components/EventTime";
import { fmtDateIn, safeZone } from "~/lib/tz";
import { readViewerZone } from "~/lib/viewer-tz";
import { closedReason, formIsOpen, readProposal, saveProposal } from "~/lib/proposal";
import {
  ProposalFields,
  initialProposalValues,
  isVisible,
  type ProposalField,
  type ProposalValues,
  type TrackOption,
} from "~/components/ProposalFields";
import {
  acceptAttribute,
  humanSize,
  humanTypes,
  maxBytesFor,
  storeUpload as putUpload,
  type UploadKind,
} from "~/lib/uploads";
import { publicBaseUrl } from "~/lib/base-url";

const LINK_TTL_MINUTES = 30;

/* Used when the event has no magic_link template of its own, so a fresh
   install can sign people in before anyone has touched the templates. */
const DEFAULT_MAGIC_LINK = {
  subject: "Your sign-in link for {{event.name}}",
  bodyHtml:
    "<p>Hi {{participant.firstName}},</p>" +
    "<p>Here is your sign-in link for {{event.name}}. It works once and expires in {{expiresInMinutes}} minutes.</p>" +
    '<p><a href="{{magicLinkUrl}}">Open your speaker portal</a></p>' +
    "<p>If you did not ask for this, you can ignore it and nothing will happen.</p>",
};

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const tab = url.searchParams.get("tab") ?? "home";

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  const eventZone = safeZone(event?.timezone);
  const viewerZone = await readViewerZone(request);

  /* --- Magic link arrival: verify, burn the token, set the cookie --- */
  if (token) {
    const row = await db.query.authTokens.findFirst({
      where: eq(authTokens.token, token),
    });
    /* An organiser sign-in link is not a portal link. Both live in the
       same table, and without this check pasting one here would open
       the portal as that person. */
    const valid =
      row &&
      row.purpose === "portal" &&
      !row.usedAt &&
      new Date(row.expiresAt).getTime() > Date.now();

    if (valid) {
      await db
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(eq(authTokens.id, row.id));
      return redirect("/portal", {
        headers: {
          "Set-Cookie": await writePortal({ participantId: row.participantId }),
        },
      });
    }
    return { state: "expired" as const, event, eventZone, viewerZone, ms: Date.now() - started };
  }

  const session = await readPortal(request);
  if (!session.participantId) {
    return { state: "login" as const, event, eventZone, viewerZone, ms: Date.now() - started };
  }

  const me = await db.query.participants.findFirst({
    where: eq(participants.id, session.participantId),
  });
  if (!me) {
    return { state: "login" as const, event, eventZone, viewerZone, ms: Date.now() - started };
  }

  const mine = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      description: submissions.description,
      status: submissions.status,
      format: submissions.format,
      level: submissions.level,
      answers: submissions.answers,
      formId: submissions.formId,
      startsAt: submissions.startsAt,
      endsAt: submissions.endsAt,
      submittedAt: submissions.submittedAt,
      trackId: submissions.trackId,
      trackName: tracks.name,
      roomName: rooms.name,
    })
    .from(submissions)
    .innerJoin(
      submissionParticipants,
      eq(submissionParticipants.submissionId, submissions.id),
    )
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(eq(submissionParticipants.participantId, me.id))
    // Newest first, and deterministic: without this the order is
    // whatever the query planner hands back, which can differ between
    // two loads of the same page.
    .orderBy(desc(submissions.refSeq));

  const accepted = mine.filter((s) => s.status === "accepted");

  const taskList = accepted.length
    ? await db
        .select()
        .from(tasks)
        .where(eq(tasks.eventId, DEMO_EVENT_ID))
        .orderBy(tasks.sortOrder)
    : [];

  const assignments = await db
    .select()
    .from(taskAssignments)
    .where(eq(taskAssignments.participantId, me.id));

  const myTasks = taskList.map((t) => {
    const a = assignments.find((x) => x.taskId === t.id);
    const status = a?.status ?? "not_started";
    const due = t.dueAt ? new Date(t.dueAt).getTime() : null;
    const done = status === "complete" || status === "waived";
    return {
      taskId: t.id,
      assignmentId: a?.id ?? null,
      name: t.name,
      description: t.description,
      kind: t.kind,
      dueAt: due,
      required: t.required,
      status,
      done,
      overdue: !done && due !== null && due < Date.now(),
      fileUrl: a?.fileUrl ?? null,
    };
  });

  /* --- The Submissions tab ------------------------------------------
     Four more queries, none of which grow with the number of rows, and
     none of which run on the other tabs: the form behind each
     submission, the field labels that make its answers readable, the
     other people on it, and the tracks the edit form offers. */
  let detail: SubmissionDetail[] = [];
  let trackList: TrackOption[] = [];

  if (tab === "submissions" && mine.length > 0) {
    const formIds = [
      ...new Set(mine.map((s) => s.formId).filter((f): f is string => !!f)),
    ];
    const ids = mine.map((s) => s.id);

    const [formRows, fieldRows, peopleRows, trackRows] = await Promise.all([
      formIds.length
        ? db
            .select({
              id: forms.id,
              name: forms.name,
              status: forms.status,
              closeAt: forms.closeAt,
            })
            .from(forms)
            .where(inArray(forms.id, formIds))
        : Promise.resolve([]),
      formIds.length
        ? db
            .select({
              id: formFields.id,
              formId: formFields.formId,
              required: formFields.required,
              conditionalRule: formFields.conditionalRule,
              key: fieldDefinitions.key,
              label: fieldDefinitions.label,
              type: fieldDefinitions.type,
              options: fieldDefinitions.options,
              helpText: fieldDefinitions.helpText,
            })
            .from(formFields)
            .innerJoin(
              fieldDefinitions,
              eq(formFields.fieldDefinitionId, fieldDefinitions.id),
            )
            .where(
              and(
                inArray(formFields.formId, formIds),
                eq(formFields.step, "submission"),
              ),
            )
            .orderBy(asc(formFields.sortOrder))
        : Promise.resolve([]),
      db
        .select({
          submissionId: submissionParticipants.submissionId,
          participantId: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
          email: participants.email,
          role: submissionParticipants.role,
          isPrimary: submissionParticipants.isPrimary,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
        .orderBy(asc(submissionParticipants.sortOrder)),
      db
        .select({ id: tracks.id, name: tracks.name })
        .from(tracks)
        .where(eq(tracks.eventId, DEMO_EVENT_ID))
        .orderBy(tracks.sortOrder),
    ]);

    trackList = trackRows;

    const formById = new Map(formRows.map((f) => [f.id, f]));

    const fieldsByForm: Record<string, ProposalField[]> = {};
    for (const f of fieldRows) {
      (fieldsByForm[f.formId] ??= []).push({
        id: f.id,
        required: f.required,
        conditionalRule: f.conditionalRule ?? null,
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.options ?? null,
        helpText: f.helpText,
      });
    }

    const peopleBySubmission: Record<string, SubmissionPerson[]> = {};
    for (const p of peopleRows) {
      (peopleBySubmission[p.submissionId] ??= []).push({
        id: p.participantId,
        name: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email,
        role: p.role,
        isPrimary: p.isPrimary,
        isMe: p.participantId === me.id,
      });
    }

    detail = mine.map((s) => {
      const form = s.formId ? (formById.get(s.formId) ?? null) : null;
      // The window is decided here, once, and the same answer drives the
      // Edit button, the read-only rendering and the action's own check.
      const canEdit = formIsOpen(form);
      return {
        id: s.id,
        ref: s.ref,
        title: s.title,
        description: s.description,
        status: s.status,
        format: s.format,
        level: s.level,
        answers: (s.answers ?? {}) as Record<string, unknown>,
        trackId: s.trackId,
        trackName: s.trackName,
        roomName: s.roomName,
        startsAt: s.startsAt ? new Date(s.startsAt).getTime() : null,
        endsAt: s.endsAt ? new Date(s.endsAt).getTime() : null,
        submittedAt: s.submittedAt ? new Date(s.submittedAt).getTime() : null,
        formName: form?.name ?? null,
        canEdit,
        closedNote: canEdit ? null : closedReason(form, eventZone),
        fields: s.formId ? (fieldsByForm[s.formId] ?? []) : [],
        people: peopleBySubmission[s.id] ?? [],
      };
    });
  }

  return {
    state: "in" as const,
    event,
    eventZone,
    viewerZone,
    me,
    mine,
    accepted,
    myTasks,
    detail,
    trackList,
    ms: Date.now() - started,
  };
}

export type SubmissionPerson = {
  id: string;
  name: string;
  role: string;
  isPrimary: boolean;
  isMe: boolean;
};

export type SubmissionDetail = {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  status: string;
  format: string | null;
  level: string | null;
  answers: Record<string, unknown>;
  trackId: string | null;
  trackName: string | null;
  roomName: string | null;
  startsAt: number | null;
  endsAt: number | null;
  submittedAt: number | null;
  formName: string | null;
  canEdit: boolean;
  closedNote: string | null;
  fields: ProposalField[];
  people: SubmissionPerson[];
};

/* The speaker's side of an upload. The work is in ~/lib/uploads, shared
   with the producer's side on /admin/people, so a file uploaded for
   somebody lands in exactly the same place as one they upload
   themselves. */
async function storeUpload(
  context: Parameters<typeof getDb>[0],
  file: File,
  kind: UploadKind,
  eventId: string,
  participantId: string,
) {
  const { env } = context.get(cloudflareContext);
  const bucket = (env as unknown as { BUCKET?: R2Bucket }).BUCKET;
  return await putUpload(bucket, file, kind, eventId, participantId);
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  /* --- Request a magic link ---------------------------------------- */
  if (intent === "request_link") {
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    const person = await db.query.participants.findFirst({
      where: and(
        eq(participants.eventId, DEMO_EVENT_ID),
        eq(participants.email, email),
      ),
    });

    // Do not reveal whether the address is known. An unknown address takes
    // the same path and produces the same confirmation as a known one.
    if (!person) return { sent: true, email, devLink: null };

    const token = crypto.randomUUID().replace(/-/g, "");
    await db.insert(authTokens).values({
      participantId: person.id,
      token,
      expiresAt: new Date(Date.now() + LINK_TTL_MINUTES * 60_000),
    });

    /* Emailed copy uses the deployment's public address; the dev
       fallback printed on screen uses this instance's own origin,
       because the token only exists in this instance's database. */
    const url = `${publicBaseUrl(context.get(cloudflareContext).env, request)}/portal?token=${token}`;
    const screenUrl = `${new URL(request.url).origin}/portal?token=${token}`;
    const event = await db.query.events.findFirst({
      where: eq(events.id, DEMO_EVENT_ID),
    });

    const tpl = await db.query.emailTemplates.findFirst({
      where: and(
        eq(emailTemplates.eventId, DEMO_EVENT_ID),
        eq(emailTemplates.key, "magic_link"),
      ),
    });

    const vars: Record<string, string> = {
      "participant.firstName": person.firstName ?? "there",
      "event.name": event?.name ?? "the event",
      magicLinkUrl: url,
      expiresInMinutes: String(LINK_TTL_MINUTES),
    };

    const subject = render(tpl?.subject ?? DEFAULT_MAGIC_LINK.subject, vars);
    const html = render(tpl?.bodyHtml ?? DEFAULT_MAGIC_LINK.bodyHtml, vars);

    const result = await sendEmail(context.get(cloudflareContext).env, {
      to: person.email,
      subject,
      html,
    });

    await db.insert(emailLog).values({
      eventId: DEMO_EVENT_ID,
      participantId: person.id,
      templateKey: "magic_link",
      toEmail: person.email,
      subject,
      bodyHtml: html,
      status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
      error: result.error ?? null,
      /* Kept on failure so the organiser can retrieve the link from
         /admin/emails and pass it on. This is the same token that was
         already minted for this one person, so nothing new is granted
         and nothing here is visible to the visitor. */
      recoveryLink: result.ok ? null : url,
      sentAt: result.ok && !result.simulated ? new Date() : null,
    });

    // A delivery failure is an operator problem, not the visitor's. It is
    // deliberately NOT reported back: a known address that fails and an
    // unknown address that was never tried have to look identical, or the
    // form becomes a way to test who is registered. The failure is in the
    // email log and in the logs.
    if (!result.ok) {
      console.error("magic link send failed for", person.id, result.error);
    }

    // With no mail provider configured nothing was actually delivered, so
    // hand the link back to keep the flow usable in development. When mail
    // is configured this is always null: the link belongs in the inbox and
    // nowhere else. Note this branch does distinguish known from unknown
    // addresses, which is acceptable only because it cannot happen once
    // RESEND_API_KEY is set.
    return {
      sent: true,
      email,
      devLink: result.simulated ? screenUrl : null,
    };
  }

  const session = await readPortal(request);
  if (!session.participantId) return redirect("/portal");

  if (intent === "sign_out") {
    return redirect("/portal", {
      headers: { "Set-Cookie": await writePortal({}) },
    });
  }

  if (intent === "save_profile") {
    // An uploaded file wins over the pasted URL, but only when one was
    // actually chosen. Everything else on the form still saves even when
    // the upload is rejected, so a bad file never costs someone their bio.
    let uploadError: string | null = null;

    const patch: Record<string, unknown> = {
      firstName: String(fd.get("firstName") ?? "") || null,
      lastName: String(fd.get("lastName") ?? "") || null,
      company: String(fd.get("company") ?? "") || null,
      jobTitle: String(fd.get("jobTitle") ?? "") || null,
      // Free text on purpose. A dropdown here is a list that is either
      // wrong or endless, and both of these are things people should be
      // able to write in their own words or leave blank.
      pronouns: String(fd.get("pronouns") ?? "").trim() || null,
      gender: String(fd.get("gender") ?? "").trim() || null,
      bio: String(fd.get("bio") ?? "") || null,
      links: {
        linkedin: String(fd.get("linkedin") ?? ""),
        twitter: String(fd.get("twitter") ?? ""),
        website: String(fd.get("website") ?? ""),
      },
      updatedAt: new Date(),
    };

    const upload = fd.get("headshotFile");
    if (upload instanceof File && upload.size > 0) {
      const stored = await storeUpload(
        context,
        upload,
        "image",
        DEMO_EVENT_ID,
        session.participantId,
      );
      if (stored.ok) patch.headshotUrl = stored.url;
      else uploadError = stored.message;
    } else if (fd.has("headshotUrl")) {
      // The URL box is only in the DOM when the speaker switched to link
      // mode. Absent means "leave the existing headshot alone"; present
      // and empty means they deliberately cleared it.
      patch.headshotUrl = String(fd.get("headshotUrl") ?? "").trim() || null;
    }

    await db
      .update(participants)
      .set(patch)
      .where(eq(participants.id, session.participantId));
    return { saved: !uploadError, uploadError };
  }

  /* --- Edit a submission -------------------------------------------- */
  if (intent === "save_submission") {
    const submissionId = String(fd.get("submissionId") ?? "");

    // The id arrives from the browser, so this is the check that stops
    // one speaker editing another's proposal by changing a hidden field.
    const link = await db.query.submissionParticipants.findFirst({
      where: and(
        eq(submissionParticipants.submissionId, submissionId),
        eq(submissionParticipants.participantId, session.participantId),
      ),
    });
    if (!link) return redirect("/portal?tab=submissions");

    const sub = await db.query.submissions.findFirst({
      where: eq(submissions.id, submissionId),
    });
    if (!sub) return redirect("/portal?tab=submissions");

    const form = sub.formId
      ? await db.query.forms.findFirst({ where: eq(forms.id, sub.formId) })
      : null;

    // Re-checked server side. A close date that only hides a button is
    // not a close date, and the browser still has the old page open.
    if (!formIsOpen(form)) {
      return {
        saved: false,
        editError:
          "Editing has closed for this form, so nothing was saved. Reload to see the current version.",
        submissionId,
      };
    }

    await saveProposal(db, {
      submissionId,
      eventId: sub.eventId,
      formId: sub.formId,
      patch: readProposal(fd),
    });

    return redirect(`/portal?tab=submissions&saved=${submissionId}`);
  }

  if (intent === "complete_task") {
    const taskId = String(fd.get("taskId"));
    const assignmentId = String(fd.get("assignmentId") ?? "");
    const kind = String(fd.get("taskKind") ?? "");
    let fileUrl = String(fd.get("fileUrl") ?? "").trim() || null;

    const upload = fd.get("taskFile");
    if (upload instanceof File && upload.size > 0) {
      const uploadKind: UploadKind =
        kind === "upload_headshot" ? "image" : "document";
      const stored = await storeUpload(
        context,
        upload,
        uploadKind,
        DEMO_EVENT_ID,
        session.participantId,
      );
      // A rejected file must not mark the task done, or the producer sees
      // a green tick with nothing behind it.
      if (!stored.ok) return { saved: false, uploadError: stored.message, taskId };
      fileUrl = stored.url;
    }

    const needsFile = ["upload_headshot", "upload_slides"].includes(kind);
    if (needsFile && !fileUrl) {
      return {
        saved: false,
        uploadError: "Choose a file to upload, or paste a link to it.",
        taskId,
      };
    }

    if (assignmentId) {
      await db
        .update(taskAssignments)
        .set({ status: "complete", completedAt: new Date(), fileUrl })
        .where(eq(taskAssignments.id, assignmentId));
    } else {
      await db.insert(taskAssignments).values({
        taskId,
        participantId: session.participantId,
        status: "complete",
        completedAt: new Date(),
        fileUrl,
      });
    }
    return { saved: true };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */

const input =
  "mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent-solid focus:ring-4 focus:ring-accent-ring";

export function isUploadTask(kind: string) {
  return ["upload_headshot", "upload_slides"].includes(kind);
}

/* Upload with a paste-a-link escape hatch. Plenty of speakers keep slides
   in Google Drive or Notion and would rather send the link than a copy,
   and refusing that just means they email it to someone instead. */
function UploadField({
  kind,
  fileName,
  urlName,
  error,
  currentUrl,
  label,
}: {
  kind: UploadKind;
  fileName: string;
  urlName: string;
  error?: string | null;
  currentUrl?: string | null;
  label?: string;
}) {
  const [mode, setMode] = useState<"upload" | "link">("upload");

  return (
    <div>
      {label && <span className="text-[13px] font-medium">{label}</span>}

      <div className="mt-1 flex gap-1">
        {(
          [
            ["upload", "Upload a file"],
            ["link", "Paste a link"],
          ] as const
        ).map(([k, text]) => (
          <button
            key={k}
            type="button"
            onClick={() => setMode(k)}
            className={[
              "rounded-md px-2 py-1 text-[12px]",
              mode === k
                ? "bg-invert font-medium text-invert-fg"
                : "text-body hover:bg-muted-strong",
            ].join(" ")}
          >
            {text}
          </button>
        ))}
      </div>

      {mode === "upload" ? (
        <>
          <input
            type="file"
            name={fileName}
            accept={acceptAttribute(kind)}
            className="mt-2 block w-full text-[13px] file:mr-3 file:rounded-md file:border-0 file:bg-invert file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-invert-fg hover:file:bg-invert-hover"
          />
          <p className="mt-1 text-[12px] text-dim">
            {humanTypes(kind)}, up to {humanSize(maxBytesFor(kind))}.
          </p>
        </>
      ) : (
        <>
          <input
            type="url"
            name={urlName}
            defaultValue={currentUrl?.startsWith("/files/") ? "" : currentUrl ?? ""}
            placeholder="https://drive.google.com/..."
            className={input}
          />
          <p className="mt-1 text-[12px] text-dim">
            Make sure the link is viewable by anyone who has it.
          </p>
        </>
      )}

      {error && (
        <p className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}



/* Suggestions, not options. Both fields save whatever is typed, and an
   empty one stays empty. */
const PRONOUN_SUGGESTIONS = [
  "she/her",
  "he/him",
  "they/them",
  "she/they",
  "he/they",
  "any pronouns",
  "ask me",
];

const GENDER_SUGGESTIONS = [
  "Woman",
  "Man",
  "Non-binary",
  "Agender",
  "Genderfluid",
  "Prefer not to say",
];

/* Descriptions come out of a WYSIWYG field, so they arrive as HTML. The
   portal renders them as text rather than as markup: it is the
   speaker's own content, but it is still content from a form, and
   nothing on this page needs the tags. */
function toPlainText(html: string) {
  return html
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const STATUS_COPY: Record<string, { text: string; cls: string }> = {
  accepted: {
    text: "Accepted",
    cls: "bg-success-soft text-success ring-success-ring",
  },
  pending: {
    text: "Under review",
    cls: "bg-warn-soft text-warn ring-warn-ring",
  },
  accept_queue: {
    text: "Under review",
    cls: "bg-warn-soft text-warn ring-warn-ring",
  },
  decline_queue: {
    text: "Under review",
    cls: "bg-warn-soft text-warn ring-warn-ring",
  },
  declined: {
    text: "Not selected",
    cls: "bg-muted text-body ring-line",
  },
  draft: { text: "Draft", cls: "bg-muted text-body ring-line" },
  withdrawn: {
    text: "Withdrawn",
    cls: "bg-muted text-dim ring-line",
  },
};

type PortalAction = {
  saved?: boolean;
  uploadError?: string | null;
  editError?: string;
  submissionId?: string;
  taskId?: string;
  sent?: boolean;
  email?: string;
  devLink?: string | null;
};

const card = "rounded-2xl border border-line bg-surface p-5 shadow-sm";

/* --- One submission, in full ---------------------------------------- */

/* Every answer the form collected, in the order the form asked for it,
   under the label the speaker saw when they answered. Reading the
   fields rather than the raw `answers` keys is the whole point: a
   speaker should not have to work out that "workshop_prereqs" is the
   prerequisites question they wrote three paragraphs into. */
function answerRows(s: SubmissionDetail) {
  const values = initialProposalValues(s);

  if (s.fields.length === 0) {
    // No form behind this one, or its fields are gone. Fall back to the
    // columns plus whatever keys the answers blob carries, so the
    // submission is still shown in full rather than half missing.
    return [
      { id: "format", label: "Format", value: s.format ?? "" },
      { id: "track", label: "Track", value: s.trackName ?? "" },
      { id: "level", label: "Level", value: s.level ?? "" },
      ...Object.entries(s.answers).map(([k, v]) => ({
        id: k,
        label: k,
        value: v == null ? "" : String(v),
      })),
    ];
  }

  return s.fields
    .filter((f) => f.key !== "title" && f.key !== "description")
    .filter((f) => isVisible(f, values))
    .map((f) => ({
      id: f.id,
      label: f.label,
      // The track is stored as an id, so the name is the only readable
      // thing to show.
      value: f.key === "track" ? (s.trackName ?? "") : (values[f.key] ?? ""),
    }));
}

function descriptionLabel(s: SubmissionDetail) {
  return s.fields.find((f) => f.key === "description")?.label ?? "Description";
}

function SubmissionCard({
  s,
  eventZone,
  viewerZone,
  saved,
}: {
  s: SubmissionDetail;
  eventZone: string;
  viewerZone: string | null;
  saved: boolean;
}) {
  const st = STATUS_COPY[s.status] ?? STATUS_COPY.pending;
  const rows = answerRows(s);
  const minutes =
    s.startsAt && s.endsAt ? Math.round((s.endsAt - s.startsAt) / 60_000) : null;

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-faint">{s.ref}</span>
        <h2 className="text-[16px] font-semibold text-strong">
          {s.title || "Untitled"}
        </h2>
        <span
          className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${st.cls}`}
        >
          {st.text}
        </span>
      </div>

      <div className="mt-0.5 text-[12px] text-dim">
        {[
          s.formName,
          s.submittedAt
            ? `Submitted ${fmtDateIn(s.submittedAt, eventZone, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}`
            : "Not submitted yet",
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>

      {saved && (
        <p className="mt-3 cb-note cb-note-success px-3 py-2 text-[13px]">
          Saved. This is what the committee now sees.
        </p>
      )}

      {s.status === "accepted" && (
        <div className="mt-3 rounded-lg bg-subtle px-3 py-2.5 text-[13px] text-body">
          {s.startsAt ? (
            <>
              <div>
                {fmtDateIn(s.startsAt, eventZone)} at{" "}
                <EventTime
                  utcMs={s.startsAt}
                  eventZone={eventZone}
                  viewerZone={viewerZone}
                />
                {minutes ? ` · ${minutes} min` : null}
              </div>
              <div className="mt-0.5">
                {s.roomName ? `In ${s.roomName}` : "Room to be confirmed."}
              </div>
            </>
          ) : (
            "Scheduling is still being worked out. We will email you."
          )}
        </div>
      )}

      {s.description && (
        <div className="mt-4">
          <div className="text-[12px] text-dim">{descriptionLabel(s)}</div>
          <div className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-strong">
            {toPlainText(s.description)}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <dl className="mt-4 space-y-2 border-t border-line-soft pt-3">
          {rows.map((r) => (
            <div key={r.id}>
              <dt className="text-[12px] text-dim">{r.label}</dt>
              <dd className="whitespace-pre-wrap text-[13px] text-strong">
                {r.value || <span className="text-faint">Not answered</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {s.people.length > 0 && (
        <div className="mt-4 border-t border-line-soft pt-3">
          <div className="text-[12px] text-dim">On this submission</div>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
            {s.people.map((p) => (
              <li key={p.id} className="text-strong">
                {p.name}
                {p.isMe && <span className="text-dim"> (you)</span>}
                <span className="text-dim">
                  {" "}
                  · {p.isPrimary ? `Primary ${p.role}` : p.role}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 border-t border-line-soft pt-3">
        {s.canEdit ? (
          /* A link rather than a button: opening the editor is a
             navigation, and this way it survives without JavaScript and
             can be opened in a new tab. */
          <Link
            to={`/portal?tab=submissions&edit=${s.id}`}
            className="cb-btn cb-btn-secondary inline-block px-3 py-1.5 text-[13px]"
          >
            Edit submission
          </Link>
        ) : (
          <p className="text-[12px] text-dim">{s.closedNote}</p>
        )}
      </div>
    </div>
  );
}

/* --- Editing one ----------------------------------------------------- */

function SubmissionEditor({
  s,
  trackList,
  busy,
}: {
  s: SubmissionDetail;
  trackList: TrackOption[];
  busy: boolean;
}) {
  const [values, setValues] = useState<ProposalValues>(() =>
    initialProposalValues(s),
  );
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  return (
    /* Posting to the list rather than to the editor's own URL: a save
       that is refused because the form shut renders the list, where the
       banner and the closed note explain what happened. A save that
       works redirects, so this only matters on the refusal path. */
    <Form
      method="post"
      action="/portal?tab=submissions"
      className={`${card} space-y-4`}
    >
      <input type="hidden" name="intent" value="save_submission" />
      <input type="hidden" name="submissionId" value={s.id} />

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-faint">{s.ref}</span>
          <h2 className="text-[16px] font-semibold text-strong">
            Edit your submission
          </h2>
        </div>
        <p className="mt-0.5 text-[13px] text-dim">
          Changes are visible to the committee straight away.
        </p>
      </div>

      <ProposalFields
        fields={s.fields}
        trackList={trackList}
        values={values}
        onChange={set}
      />

      <div className="flex gap-2">
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-4 py-2 text-[14px]"
        >
          {busy ? "Saving" : "Save changes"}
        </button>
        <Link
          to="/portal?tab=submissions"
          className="cb-btn cb-btn-secondary inline-block px-4 py-2 text-[14px]"
        >
          Cancel
        </Link>
      </div>
    </Form>
  );
}

export default function Portal() {
  const data = useLoaderData<typeof loader>();
  const action = useActionData<PortalAction>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "home";
  const editing = params.get("edit");
  const justSaved = params.get("saved");

  /* Tab changes drop the per submission state with them, so switching
     away from a half finished edit and back does not reopen it. */
  const goTab = (next: string) => {
    const n = new URLSearchParams(params);
    n.set("tab", next);
    n.delete("edit");
    n.delete("saved");
    setParams(n);
  };

  const shell = (children: React.ReactNode, showTabs = false) => (
    <div className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <div className="text-[12px] font-medium uppercase tracking-[0.1em] text-dim">
              {data.event?.name}
            </div>
            <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-strong">
              Speaker portal
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle compact />
            {data.state === "in" && (
              <Form method="post">
                <input type="hidden" name="intent" value="sign_out" />
                <button className="text-[13px] text-dim underline-offset-2 hover:text-strong hover:underline">
                  Sign out
                </button>
              </Form>
            )}
          </div>
        </div>

        {showTabs && (
          <div className="mb-4 flex gap-1">
            {[
              ["home", "Home"],
              ["submissions", "Submissions"],
              ["tasks", "Tasks"],
              ["profile", "Profile"],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => goTab(k)}
                className={[
                  "rounded-lg px-3 py-1.5 text-[13px]",
                  tab === k
                    ? "bg-invert font-medium text-invert-fg"
                    : "text-body hover:bg-muted-strong",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {children}

        <div className="mt-4 flex justify-between text-[12px] text-faint">
          <span>Powered by Callboard</span>
          <span className="font-mono tabular-nums">{data.ms} ms</span>
        </div>
      </div>
    </div>
  );

  if (data.state === "login" || data.state === "expired") {
    // After a successful request the form is replaced by the confirmation.
    // Leaving the form up invites people to hammer it while the first mail
    // is still in flight.
    if (action?.sent) {
      return shell(
        <div className={card}>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-solid text-[13px] text-on-solid">
              ✓
            </div>
            <div>
              <h2 className="text-[16px] font-semibold">Check your email</h2>
              <p className="mt-1 text-[13px] text-body">
                If {action.email ? <strong>{action.email}</strong> : "that address"}{" "}
                is registered for this event, a sign-in link is on its way. It
                works once and expires in {LINK_TTL_MINUTES} minutes.
              </p>
              <p className="mt-2 text-[12px] text-dim">
                Nothing arrived? Check spam, then request another link.
              </p>
            </div>
          </div>

          {action.devLink && (
            <div className="mt-4 rounded-lg border border-dashed border-warn-ring bg-warn-soft px-3 py-2.5">
              <div className="text-[12px] font-medium text-warn">
                Development mode
              </div>
              <p className="mt-0.5 text-[12px] text-warn">
                No mail provider is configured, so nothing was delivered. Use
                this link to continue:
              </p>
              <a
                href={action.devLink}
                className="mt-1.5 block break-all font-mono text-[12px] text-accent-text underline underline-offset-2"
              >
                {action.devLink}
              </a>
            </div>
          )}

          <Form method="post" className="mt-4">
            <input type="hidden" name="intent" value="request_link" />
            <input type="hidden" name="email" value={action.email ?? ""} />
            <button
              disabled={busy}
              className="text-[13px] text-dim underline-offset-2 hover:text-strong hover:underline disabled:opacity-50"
            >
              {busy ? "Sending" : "Send another link"}
            </button>
          </Form>
        </div>,
      );
    }

    return shell(
      <div className={card}>
        {data.state === "expired" && (
          <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            That link has expired or was already used. Request a new one.
          </p>
        )}
        <h2 className="text-[16px] font-semibold">Sign in</h2>
        <p className="mt-0.5 text-[13px] text-dim">
          We will email you a link. No password to remember.
        </p>
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="request_link" />
          <label className="block">
            <span className="text-[13px] font-medium">Email</span>
            <input
              name="email"
              type="email"
              required
              className={input}
              placeholder="you@company.com"
            />
          </label>
          <button
            disabled={busy}
            className="rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
          >
            {busy ? "Sending" : "Send me a link"}
          </button>
        </Form>
      </div>,
    );
  }

  const { me, mine, accepted, myTasks, detail, trackList } = data;
  const open = myTasks.filter((t) => !t.done);

  if (tab === "submissions") {
    // An edit link for a submission whose form has since closed falls
    // through to the read-only card, which says so.
    const target = editing
      ? detail.find((d) => d.id === editing && d.canEdit)
      : null;

    if (target) {
      return shell(
        <SubmissionEditor key={target.id} s={target} trackList={trackList} busy={busy} />,
        true,
      );
    }

    return shell(
      <div className="space-y-3">
        {/* A save refused because the form shut while the editor was
            open. The card underneath says when it closed. */}
        {action?.editError && (
          <p className="cb-note cb-note-danger px-3 py-2.5 text-[13px]">
            {action.editError}
          </p>
        )}
        {detail.length === 0 ? (
          <div className={card}>
            <p className="text-[14px] font-medium">Nothing here yet</p>
            <p className="mt-1 text-[13px] text-dim">
              Anything you submit, on your own or with someone else, shows up
              here in full.
            </p>
          </div>
        ) : (
          detail.map((s) => (
            <SubmissionCard
              key={s.id}
              s={s}
              eventZone={data.eventZone}
              viewerZone={data.viewerZone}
              saved={justSaved === s.id}
            />
          ))
        )}
      </div>,
      true,
    );
  }

  if (tab === "tasks") {
    return shell(
      <div className="space-y-3">
        {accepted.length === 0 ? (
          <div className={card}>
            <p className="text-[14px] font-medium">No tasks yet</p>
            <p className="mt-1 text-[13px] text-dim">
              Once a submission is accepted, everything we need from you shows up
              here.
            </p>
          </div>
        ) : (
          myTasks.map((t) => (
            <div key={t.taskId} className={card}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-strong">
                      {t.name}
                    </span>
                    {t.done ? (
                      <span className="rounded bg-success-soft px-1.5 py-0.5 text-[11px] font-medium text-success">
                        Done
                      </span>
                    ) : t.overdue ? (
                      <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger">
                        Overdue
                      </span>
                    ) : null}
                  </div>
                  {t.description && (
                    <p className="mt-0.5 text-[13px] text-dim">
                      {t.description}
                    </p>
                  )}
                  {t.dueAt && !t.done && (
                    <p className="mt-1 text-[12px] text-dim">
                      Due{" "}
                      {new Date(t.dueAt).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                      })}
                    </p>
                  )}
                </div>
              </div>

              {!t.done && (
                <Form
                  method="post"
                  encType="multipart/form-data"
                  className="mt-3"
                >
                  <input type="hidden" name="intent" value="complete_task" />
                  <input type="hidden" name="taskId" value={t.taskId} />
                  <input type="hidden" name="taskKind" value={t.kind} />
                  <input
                    type="hidden"
                    name="assignmentId"
                    value={t.assignmentId ?? ""}
                  />

                  {isUploadTask(t.kind) ? (
                    <UploadField
                      kind={t.kind === "upload_headshot" ? "image" : "document"}
                      fileName="taskFile"
                      urlName="fileUrl"
                      error={
                        action?.taskId === t.taskId
                          ? action?.uploadError
                          : undefined
                      }
                    />
                  ) : null}

                  <button
                    disabled={busy}
                    className="mt-2 rounded-lg bg-invert px-3 py-1.5 text-[13px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
                  >
                    {busy ? "Saving" : "Mark done"}
                  </button>
                </Form>
              )}

              {t.done && t.fileUrl && (
                <a
                  href={t.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-[12px] text-accent-text underline underline-offset-2"
                >
                  View what you sent
                </a>
              )}
            </div>
          ))
        )}
      </div>,
      true,
    );
  }

  if (tab === "profile") {
    const links = (me.links ?? {}) as Record<string, string>;
    return shell(
      <Form
        method="post"
        encType="multipart/form-data"
        className={`${card} space-y-4`}
      >
        <input type="hidden" name="intent" value="save_profile" />
        <div>
          <h2 className="text-[16px] font-semibold">Your details</h2>
          <p className="mt-0.5 text-[13px] text-dim">
            This is what appears on the website and what the host reads out
            before your session.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[13px] font-medium">First name</span>
            <input name="firstName" defaultValue={me.firstName ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Last name</span>
            <input name="lastName" defaultValue={me.lastName ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Company</span>
            <input name="company" defaultValue={me.company ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Job title</span>
            <input name="jobTitle" defaultValue={me.jobTitle ?? ""} className={input} />
          </label>
        </div>

        {/* Both optional, both free text. The suggestions are a shortcut
            for the common answers, not the set of allowed ones: a fixed
            list here would be a promise that the list is complete, and
            neither of these has a complete list. */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[13px] font-medium">
              Pronouns <span className="font-normal text-dim">(optional)</span>
            </span>
            <input
              name="pronouns"
              list="pronoun-suggestions"
              defaultValue={me.pronouns ?? ""}
              placeholder="they/them"
              className={input}
            />
            <datalist id="pronoun-suggestions">
              {PRONOUN_SUGGESTIONS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="mt-1 block text-[12px] text-dim">
              Used when we introduce you.
            </span>
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">
              Gender <span className="font-normal text-dim">(optional)</span>
            </span>
            <input
              name="gender"
              list="gender-suggestions"
              defaultValue={me.gender ?? ""}
              placeholder="Leave blank if you would rather not say"
              className={input}
            />
            <datalist id="gender-suggestions">
              {GENDER_SUGGESTIONS.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <span className="mt-1 block text-[12px] text-dim">
              Not shown on the public programme.
            </span>
          </label>
        </div>

        <label className="block">
          <span className="text-[13px] font-medium">Biography</span>
          <textarea
            name="bio"
            rows={6}
            defaultValue={me.bio ?? ""}
            className={input}
          />
        </label>

        <div>
          {me.headshotUrl && (
            <div className="mb-2 flex items-center gap-3">
              <img
                src={me.headshotUrl}
                alt="Your current headshot"
                className="h-14 w-14 rounded-full object-cover ring-1 ring-line"
              />
              <div className="text-[12px] text-dim">
                Current headshot.
                <br />
                Uploading a new one replaces it.
              </div>
            </div>
          )}
          <UploadField
            kind="image"
            label="Headshot"
            fileName="headshotFile"
            urlName="headshotUrl"
            currentUrl={me.headshotUrl}
            error={action?.uploadError}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-[13px] font-medium">LinkedIn</span>
            <input name="linkedin" defaultValue={links.linkedin ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">X</span>
            <input name="twitter" defaultValue={links.twitter ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Website</span>
            <input name="website" defaultValue={links.website ?? ""} className={input} />
          </label>
        </div>

        <button
          disabled={busy}
          className="rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
        >
          {busy ? "Saving" : "Save"}
        </button>
      </Form>,
      true,
    );
  }

  // Home
  return shell(
    <div className="space-y-4">
      {open.length > 0 && (
        <div className="rounded-2xl border border-warn-ring bg-warn-soft p-4">
          <div className="text-[14px] font-medium text-warn">
            {open.length} thing{open.length > 1 ? "s" : ""} still needed from you
          </div>
          <ul className="mt-1 space-y-0.5 text-[13px] text-warn">
            {open.slice(0, 3).map((t) => (
              <li key={t.taskId}>
                {t.name}
                {t.overdue && <span className="font-medium"> (overdue)</span>}
              </li>
            ))}
          </ul>
          <button
            onClick={() => goTab("tasks")}
            className="mt-2 rounded-lg cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
          >
            Take care of it
          </button>
        </div>
      )}

      <div className={card}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[16px] font-semibold">Your submissions</h2>
          {mine.length > 0 && (
            <button
              onClick={() => goTab("submissions")}
              className="text-[13px] text-accent-text underline-offset-2 hover:underline"
            >
              See them in full
            </button>
          )}
        </div>
        {mine.length === 0 ? (
          <p className="mt-2 text-[13px] text-dim">
            Nothing here yet.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {mine.map((s) => {
              const st = STATUS_COPY[s.status] ?? STATUS_COPY.pending;
              return (
                <div
                  key={s.id}
                  className="rounded-lg border border-line px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-faint">
                      {s.ref}
                    </span>
                    <span className="text-[14px] font-medium text-strong">
                      {s.title || "Untitled"}
                    </span>
                    <span
                      className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${st.cls}`}
                    >
                      {st.text}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-dim">
                    {[s.format, s.trackName].filter(Boolean).join(" · ")}
                  </div>
                  {s.status === "accepted" && (
                    <div className="mt-1.5 rounded-md bg-subtle px-2 py-1.5 text-[12px] text-body">
                      {s.startsAt ? (
                        <>
                          {fmtDateIn(
                            new Date(s.startsAt).getTime(),
                            data.eventZone,
                          )}{" "}
                          at{" "}
                          <EventTime
                            utcMs={new Date(s.startsAt).getTime()}
                            eventZone={data.eventZone}
                            viewerZone={data.viewerZone}
                          />
                          {s.roomName ? ` in ${s.roomName}` : " (room to be confirmed)"}
                        </>
                      ) : (
                        "Scheduling is still being worked out. We will email you."
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    true,
  );
}

