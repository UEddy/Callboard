import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  participants,
  authTokens,
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
import {
  acceptAttribute,
  buildKey,
  humanSize,
  humanTypes,
  maxBytesFor,
  publicPathFor,
  validateUpload,
  type UploadKind,
} from "~/lib/uploads";

const EVENT_UTC_OFFSET = -7;

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

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  /* --- Magic link arrival: verify, burn the token, set the cookie --- */
  if (token) {
    const row = await db.query.authTokens.findFirst({
      where: eq(authTokens.token, token),
    });
    const valid =
      row && !row.usedAt && new Date(row.expiresAt).getTime() > Date.now();

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
    return { state: "expired" as const, event, ms: Date.now() - started };
  }

  const session = await readPortal(request);
  if (!session.participantId) {
    return { state: "login" as const, event, ms: Date.now() - started };
  }

  const me = await db.query.participants.findFirst({
    where: eq(participants.id, session.participantId),
  });
  if (!me) {
    return { state: "login" as const, event, ms: Date.now() - started };
  }

  const mine = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      startsAt: submissions.startsAt,
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
    .where(eq(submissionParticipants.participantId, me.id));

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

  return {
    state: "in" as const,
    event,
    me,
    mine,
    accepted,
    myTasks,
    ms: Date.now() - started,
  };
}

/* Takes a File off the form, validates it, and puts it in R2. Returns the
   public path, or a message the speaker can act on. Never throws: a
   rejected file is an ordinary outcome of asking people for files. */
async function storeUpload(
  context: Parameters<typeof getDb>[0],
  file: File,
  kind: UploadKind,
  eventId: string,
  participantId: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const { env } = context.get(cloudflareContext);
  const bucket = (env as unknown as { BUCKET?: R2Bucket }).BUCKET;

  if (!bucket) {
    return {
      ok: false,
      message:
        "File storage is not set up on this deployment. Paste a link instead.",
    };
  }

  const checked = await validateUpload(file, kind);
  if (!checked.ok) return { ok: false, message: checked.message };

  const key = buildKey(eventId, participantId, checked.filename);

  try {
    await bucket.put(key, checked.bytes, {
      httpMetadata: { contentType: checked.contentType },
      customMetadata: {
        eventId,
        participantId,
        originalName: file.name.slice(0, 200),
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    return {
      ok: false,
      message: `The upload did not complete. Try again, or paste a link instead. (${String(e).slice(0, 120)})`,
    };
  }

  return { ok: true, url: publicPathFor(key) };
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

    const url = `${new URL(request.url).origin}/portal?token=${token}`;
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
      status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
      error: result.error ?? null,
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
      devLink: result.simulated ? url : null,
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

function fmtSession(ms: number | null) {
  if (!ms) return null;
  const d = new Date(ms + EVENT_UTC_OFFSET * 3_600_000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })} at ${hh}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} PT`;
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
  taskId?: string;
  sent?: boolean;
  email?: string;
  devLink?: string | null;
};

export default function Portal() {
  const data = useLoaderData<typeof loader>();
  const action = useActionData<PortalAction>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "home";

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
              ["tasks", "Tasks"],
              ["profile", "Profile"],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.set("tab", k);
                  setParams(n);
                }}
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

  const card = "rounded-2xl border border-line bg-surface p-5 shadow-sm";

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

  const { me, mine, accepted, myTasks } = data;
  const open = myTasks.filter((t) => !t.done);

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
            onClick={() => {
              const n = new URLSearchParams(params);
              n.set("tab", "tasks");
              setParams(n);
            }}
            className="mt-2 rounded-lg cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
          >
            Take care of it
          </button>
        </div>
      )}

      <div className={card}>
        <h2 className="text-[16px] font-semibold">Your submissions</h2>
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
                          {fmtSession(new Date(s.startsAt).getTime())}
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

