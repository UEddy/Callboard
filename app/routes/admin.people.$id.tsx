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
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  emailLog,
  events,
  participants,
  rooms,
  submissionParticipants,
  submissions,
  taskAssignments,
  tasks,
  tracks,
} from "~/db/schema";
import {
  SIGN_IN_LINK_TTL_HOURS,
  displayName,
  emailTaken,
  mintSignInLink,
  readPersonForm,
} from "~/lib/people";
import {
  acceptAttribute,
  humanSize,
  humanTypes,
  maxBytesFor,
  publicPathFor,
  storeUpload,
} from "~/lib/uploads";
import { STATUS_STYLE, statusLabel } from "~/lib/submission-list";
import { fmtDateIn, safeZone } from "~/lib/tz";
import { readViewerZone } from "~/lib/viewer-tz";
import { EventTime } from "~/components/EventTime";
import { Avatar, CopyLine } from "~/components/People";
import { publicBaseUrl } from "~/lib/base-url";

/* ------------------------------------------------------------------ *
 * One person, everything about them.
 *
 * The producer's version of the speaker portal: the same profile, the
 * same submissions, the same task list, but editable and with the files
 * actually in the bucket listed rather than only the ones a form
 * recorded a URL for. If a speaker cannot upload their own headshot,
 * this is where somebody does it for them.
 * ------------------------------------------------------------------ */

export async function loader({ context, params, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const id = params.id!;

  const person = await db.query.participants.findFirst({
    where: and(eq(participants.id, id), eq(participants.eventId, DEMO_EVENT_ID)),
  });
  if (!person) throw new Response("Person not found", { status: 404 });

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  const theirSubmissions = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      kind: submissions.kind,
      format: submissions.format,
      startsAt: submissions.startsAt,
      endsAt: submissions.endsAt,
      isDraftSchedule: submissions.isDraftSchedule,
      role: submissionParticipants.role,
      isPrimary: submissionParticipants.isPrimary,
      trackName: tracks.name,
      trackColor: tracks.color,
      roomName: rooms.name,
    })
    .from(submissionParticipants)
    .innerJoin(submissions, eq(submissionParticipants.submissionId, submissions.id))
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(
      and(
        eq(submissionParticipants.participantId, id),
        eq(submissions.eventId, DEMO_EVENT_ID),
      ),
    )
    .orderBy(desc(submissions.refSeq));

  const theirTasks = await db
    .select({
      id: taskAssignments.id,
      status: taskAssignments.status,
      fileUrl: taskAssignments.fileUrl,
      notes: taskAssignments.notes,
      completedAt: taskAssignments.completedAt,
      lastNudgedAt: taskAssignments.lastNudgedAt,
      name: tasks.name,
      description: tasks.description,
      required: tasks.required,
      dueAt: tasks.dueAt,
      sortOrder: tasks.sortOrder,
      submissionRef: submissions.ref,
    })
    .from(taskAssignments)
    .innerJoin(tasks, eq(taskAssignments.taskId, tasks.id))
    .leftJoin(submissions, eq(taskAssignments.submissionId, submissions.id))
    .where(
      and(
        eq(taskAssignments.participantId, id),
        eq(tasks.eventId, DEMO_EVENT_ID),
      ),
    )
    .orderBy(asc(tasks.sortOrder));

  const mail = await db
    .select({
      id: emailLog.id,
      subject: emailLog.subject,
      templateKey: emailLog.templateKey,
      status: emailLog.status,
      sentAt: emailLog.sentAt,
      createdAt: emailLog.createdAt,
    })
    .from(emailLog)
    .where(eq(emailLog.participantId, id))
    .orderBy(desc(emailLog.createdAt))
    .limit(8);

  /* Everything actually in the bucket under this person's prefix, not
     only what a form remembered the URL of. An upload whose row was
     lost is exactly the file somebody is hunting for. */
  const bucket = (
    context.get(cloudflareContext).env as unknown as { BUCKET?: R2Bucket }
  ).BUCKET;
  let files: { key: string; url: string; name: string; size: number; uploaded: number }[] =
    [];
  if (bucket) {
    try {
      const listed = await bucket.list({
        prefix: `events/${DEMO_EVENT_ID}/${id}/`,
        limit: 100,
      });
      files = listed.objects.map((o) => ({
        key: o.key,
        url: publicPathFor(o.key),
        name: o.key.split("/").pop() ?? o.key,
        size: o.size,
        uploaded: o.uploaded.getTime(),
      }));
      files.sort((a, b) => b.uploaded - a.uploaded);
    } catch {
      // A bucket that is unreachable must not take the page down with it.
      files = [];
    }
  }

  return {
    person: {
      ...person,
      name: displayName(person),
      createdAt: new Date(person.createdAt).getTime(),
      updatedAt: new Date(person.updatedAt).getTime(),
    },
    submissions: theirSubmissions.map((s) => ({
      ...s,
      startsAt: s.startsAt ? new Date(s.startsAt).getTime() : null,
      endsAt: s.endsAt ? new Date(s.endsAt).getTime() : null,
    })),
    tasks: theirTasks.map((t) => ({
      ...t,
      dueAt: t.dueAt ? new Date(t.dueAt).getTime() : null,
      completedAt: t.completedAt ? new Date(t.completedAt).getTime() : null,
    })),
    mail: mail.map((m) => ({
      ...m,
      at: new Date(m.sentAt ?? m.createdAt).getTime(),
    })),
    files,
    storageConfigured: Boolean(bucket),
    eventZone: safeZone(event?.timezone),
    viewerZone: await readViewerZone(request),
    ms: Date.now() - started,
  };
}

export async function action({ context, params, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const id = params.id!;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  const person = await db.query.participants.findFirst({
    where: and(eq(participants.id, id), eq(participants.eventId, DEMO_EVENT_ID)),
  });
  if (!person) throw new Response("Person not found", { status: 404 });

  if (intent === "signin_link") {
    const link = await mintSignInLink(
      db,
      id,
      publicBaseUrl(context.get(cloudflareContext).env, request),
    );
    return { signInLink: link };
  }

  if (intent === "save") {
    const parsed = readPersonForm(fd);
    if (!parsed.ok) return { error: parsed.error };

    if (
      parsed.email !== person.email &&
      (await emailTaken(db, parsed.email, id))
    ) {
      return {
        error: `${parsed.email} already belongs to somebody else on this event. Two records for one address would split their submissions and their tasks.`,
      };
    }

    /* The upload is allowed to fail on its own. Losing a rewritten bio
       because a headshot was the wrong format would be a poor trade. */
    let uploadError: string | null = null;
    const patch: Record<string, unknown> = { ...parsed.values };

    const upload = fd.get("headshotFile");
    if (upload instanceof File && upload.size > 0) {
      const bucket = (
        context.get(cloudflareContext).env as unknown as { BUCKET?: R2Bucket }
      ).BUCKET;
      const stored = await storeUpload(bucket, upload, "image", DEMO_EVENT_ID, id);
      if (stored.ok) patch.headshotUrl = stored.url;
      else uploadError = stored.message;
    } else {
      // Present and empty means the producer cleared it deliberately.
      patch.headshotUrl = String(fd.get("headshotUrl") ?? "").trim() || null;
    }

    await db.update(participants).set(patch).where(eq(participants.id, id));

    return uploadError
      ? { error: uploadError, saved: "Everything except the headshot was saved." }
      : { saved: "Saved." };
  }

  return { error: "Unknown action." };
}

/* --- UI --------------------------------------------------------------- */

const field =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong outline-none focus:border-accent-solid focus:ring-2 focus:ring-accent-ring";

const TASK_STYLE: Record<string, string> = {
  complete: "cb-pill-success",
  waived: "cb-pill-neutral",
  in_progress: "cb-pill-warn",
  not_started: "cb-pill-neutral",
  overdue: "cb-pill-danger",
};

const TASK_LABEL: Record<string, string> = {
  complete: "Done",
  waived: "Waived",
  in_progress: "Started",
  not_started: "Not started",
  overdue: "Overdue",
};

function LinkRow({ label, href }: { label: string; href: string }) {
  const url = /^https?:\/\//i.test(href) ? href : `https://${href}`;
  return (
    <div className="flex gap-3 text-[13px]">
      <span className="w-20 shrink-0 text-dim">{label}</span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 break-all text-accent-text underline-offset-2 hover:underline"
      >
        {href}
      </a>
    </div>
  );
}

export default function PersonDetail() {
  const {
    person,
    submissions,
    tasks,
    mail,
    files,
    storageConfigured,
    eventZone,
    viewerZone,
    ms,
  } = useLoaderData<typeof loader>();
  const action = useActionData<{
    error?: string;
    saved?: string;
    signInLink?: string;
  }>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [headshotMode, setHeadshotMode] = useState<"upload" | "link">("upload");

  const links = (person.links ?? {}) as Record<string, string>;
  const now = Date.now();
  const requiredTotal = tasks.filter((t) => t.required).length;
  const requiredDone = tasks.filter(
    (t) => t.required && (t.status === "complete" || t.status === "waived"),
  ).length;

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              to="/admin/people"
              className="text-[12px] text-dim underline-offset-2 hover:underline"
            >
              People
            </Link>
            <div className="mt-1 flex items-center gap-3">
              <Avatar src={person.headshotUrl} name={person.name} size={44} />
              <div className="min-w-0">
                <h1 className="text-[19px] font-semibold tracking-tight">
                  {person.name}
                </h1>
                <p className="text-[13px] text-dim">
                  {[person.jobTitle, person.company].filter(Boolean).join(", ") ||
                    "No job title or company on file"}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {person.isEvaluator && (
                    <span className="cb-pill cb-pill-accent">Evaluator</span>
                  )}
                  {person.isAdmin && (
                    <span className="cb-pill cb-pill-neutral">Admin</span>
                  )}
                  {person.pronouns && (
                    <span className="cb-pill cb-pill-neutral">
                      {person.pronouns}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="cb-btn cb-btn-secondary px-2.5 py-1.5 text-[13px]"
            >
              {editing ? "Close editor" : "Edit person"}
            </button>
            <Link
              to={`/admin/emails?compose=1&to=${person.id}`}
              className="cb-btn cb-btn-secondary px-2.5 py-1.5 text-[13px]"
            >
              Email
            </Link>
            <div
              className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim"
              title="Server render time for this page"
            >
              {ms} ms
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 px-6 py-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          {params.get("created") === "1" && (
            <p className="cb-note cb-note-success px-3 py-2.5 text-[13px]">
              Person created. They are on the roster now, and you can send them
              a sign-in link so they can fill in the rest themselves.
            </p>
          )}
          {action?.saved && (
            <p className="cb-note cb-note-success px-3 py-2.5 text-[13px]">
              {action.saved}
            </p>
          )}
          {action?.error && (
            <p className="cb-note cb-note-danger px-3 py-2.5 text-[13px]">
              {action.error}
            </p>
          )}

          {editing && (
            <Form
              method="post"
              encType="multipart/form-data"
              className="space-y-3 rounded-lg border border-line bg-surface p-4"
            >
              <input type="hidden" name="intent" value="save" />
              <h2 className="text-[14px] font-semibold">Edit person</h2>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-[13px] font-medium">First name</span>
                  <input
                    name="firstName"
                    defaultValue={person.firstName ?? ""}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium">Last name</span>
                  <input
                    name="lastName"
                    defaultValue={person.lastName ?? ""}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium">Email</span>
                  <input
                    name="email"
                    type="email"
                    required
                    defaultValue={person.email}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium">Company</span>
                  <input
                    name="company"
                    defaultValue={person.company ?? ""}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium">Job title</span>
                  <input
                    name="jobTitle"
                    defaultValue={person.jobTitle ?? ""}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium">Pronouns</span>
                  <input
                    name="pronouns"
                    defaultValue={person.pronouns ?? ""}
                    className={field}
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-[13px] font-medium">Bio</span>
                <span className="block text-[12px] text-dim">
                  Goes on the public programme and into the emcee's notes.
                </span>
                <textarea
                  name="bio"
                  rows={5}
                  defaultValue={person.bio ?? ""}
                  className={field}
                />
              </label>

              <fieldset className="rounded-md border border-line-soft p-3">
                <legend className="px-1 text-[12px] font-medium text-dim">
                  Headshot
                </legend>
                <div className="flex items-start gap-3">
                  <Avatar src={person.headshotUrl} name={person.name} size={56} />
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex gap-1">
                      {(["upload", "link"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setHeadshotMode(m)}
                          className={[
                            "rounded-md px-2 py-1 text-[12px]",
                            headshotMode === m
                              ? "bg-accent-soft font-medium text-accent-text"
                              : "text-dim hover:bg-muted hover:text-strong",
                          ].join(" ")}
                        >
                          {m === "upload" ? "Upload a file" : "Paste a link"}
                        </button>
                      ))}
                    </div>

                    {headshotMode === "upload" ? (
                      <>
                        <input
                          type="file"
                          name="headshotFile"
                          accept={acceptAttribute("image")}
                          className="block w-full text-[12px] text-body file:mr-2 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-2 file:py-1 file:text-[12px] file:text-body"
                        />
                        <p className="mt-1 text-[12px] text-dim">
                          {humanTypes("image")}, up to{" "}
                          {humanSize(maxBytesFor("image"))}. Leaving this empty
                          keeps the current headshot.
                        </p>
                        <input
                          type="hidden"
                          name="headshotUrl"
                          value={person.headshotUrl ?? ""}
                        />
                      </>
                    ) : (
                      <>
                        <input
                          name="headshotUrl"
                          defaultValue={person.headshotUrl ?? ""}
                          placeholder="https://..."
                          className={field}
                        />
                        <p className="mt-1 text-[12px] text-dim">
                          Clear the box to remove the headshot.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </fieldset>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-[13px] font-medium">LinkedIn</span>
                  <input
                    name="linkedin"
                    defaultValue={links.linkedin ?? ""}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium">X / Twitter</span>
                  <input
                    name="twitter"
                    defaultValue={links.twitter ?? ""}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium">Website</span>
                  <input
                    name="website"
                    defaultValue={links.website ?? ""}
                    className={field}
                  />
                </label>
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="isEvaluator"
                  defaultChecked={person.isEvaluator}
                  className="h-4 w-4 rounded border-line-strong"
                />
                <span className="text-[13px]">Evaluator</span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  disabled={busy}
                  className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
                >
                  {busy ? "Saving" : "Save person"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]"
                >
                  Cancel
                </button>
              </div>
            </Form>
          )}

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Bio</h2>
            <div className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-body">
              {person.bio || (
                <span className="text-faint">
                  No bio yet. The programme page and the emcee's notes both
                  read from this.
                </span>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">
              Submissions{" "}
              <span className="font-normal text-faint">{submissions.length}</span>
            </h2>
            {submissions.length === 0 ? (
              <p className="mt-2 text-[13px] text-dim">
                Not attached to any submission on this event.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line-soft">
                {submissions.map((s) => (
                  <li key={`${s.id}-${s.role}`} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] text-faint">
                        {s.ref}
                      </span>
                      <Link
                        to={`/admin/submissions/${s.id}`}
                        className="font-medium text-strong underline-offset-2 hover:underline"
                      >
                        {s.title || "Untitled"}
                      </Link>
                      <span
                        className={[
                          "rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                          STATUS_STYLE[s.status] ?? STATUS_STYLE.draft,
                        ].join(" ")}
                      >
                        {statusLabel(s.status)}
                      </span>
                      <span className="cb-pill cb-pill-neutral">
                        {s.isPrimary ? `Primary ${s.role}` : s.role}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-dim">
                      {s.trackName && (
                        <span className="mr-2 inline-flex items-center gap-1.5">
                          <span
                            className="cb-dot h-2 w-2"
                            style={
                              {
                                ["--cb-hue"]: s.trackColor ?? "#94a3b8",
                              } as React.CSSProperties
                            }
                          />
                          {s.trackName}
                        </span>
                      )}
                      {s.startsAt ? (
                        <>
                          <EventTime
                            utcMs={s.startsAt}
                            eventZone={eventZone}
                            viewerZone={viewerZone}
                          />
                          {s.roomName ? ` · ${s.roomName}` : " · room to be confirmed"}
                          {s.isDraftSchedule && " · draft schedule"}
                        </>
                      ) : (
                        "Not scheduled"
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold">
                Tasks{" "}
                <span className="font-normal text-faint">{tasks.length}</span>
              </h2>
              {requiredTotal > 0 && (
                <span className="text-[12px] tabular-nums text-dim">
                  {requiredDone}/{requiredTotal} required done
                </span>
              )}
            </div>
            {tasks.length === 0 ? (
              <p className="mt-2 text-[13px] text-dim">
                Nothing assigned. Tasks are created on{" "}
                <Link
                  to="/admin/tasks"
                  className="text-accent-text underline underline-offset-2"
                >
                  Tasks
                </Link>{" "}
                and reach a speaker when their submission is accepted.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line-soft">
                {tasks.map((t) => {
                  const done = t.status === "complete" || t.status === "waived";
                  const overdue = !done && t.dueAt !== null && t.dueAt < now;
                  const state = overdue ? "overdue" : t.status;
                  return (
                    <li
                      key={t.id}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 first:pt-0 last:pb-0"
                    >
                      <span className={`cb-pill ${TASK_STYLE[state] ?? "cb-pill-neutral"}`}>
                        {TASK_LABEL[state] ?? state}
                      </span>
                      <span className="font-medium text-strong">{t.name}</span>
                      {!t.required && (
                        <span className="text-[12px] text-faint">optional</span>
                      )}
                      {t.submissionRef && (
                        <span className="font-mono text-[11px] text-faint">
                          {t.submissionRef}
                        </span>
                      )}
                      <span className="text-[12px] text-dim">
                        {t.dueAt
                          ? `due ${fmtDateIn(t.dueAt, eventZone, {
                              day: "numeric",
                              month: "short",
                            })}`
                          : "no date"}
                      </span>
                      {t.fileUrl && (
                        <a
                          href={t.fileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12px] text-accent-text underline-offset-2 hover:underline"
                        >
                          Open file
                        </a>
                      )}
                      {t.notes && (
                        <span className="basis-full text-[12px] text-dim">
                          {t.notes}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">
              Uploaded files{" "}
              <span className="font-normal text-faint">{files.length}</span>
            </h2>
            {!storageConfigured ? (
              <p className="mt-2 text-[13px] text-dim">
                File storage is not configured on this deployment.
              </p>
            ) : files.length === 0 ? (
              <p className="mt-2 text-[13px] text-dim">
                Nothing uploaded. Headshots and slides land here as soon as
                they arrive, whether the speaker uploads them or you do.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line-soft">
                {files.map((f) => (
                  <li
                    key={f.key}
                    className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 break-all text-[13px] text-accent-text underline-offset-2 hover:underline"
                    >
                      {f.name}
                    </a>
                    <span className="shrink-0 text-[12px] tabular-nums text-dim">
                      {humanSize(f.size)} ·{" "}
                      {fmtDateIn(f.uploaded, eventZone, {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Contact</h2>
            <dl className="mt-2 space-y-1.5 text-[13px]">
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-dim">Email</dt>
                <dd className="min-w-0 break-all">
                  <a
                    href={`mailto:${person.email}`}
                    className="text-accent-text underline-offset-2 hover:underline"
                  >
                    {person.email}
                  </a>
                </dd>
              </div>
              {[
                ["Phone", person.phone],
                ["Company", person.company],
                ["Job title", person.jobTitle],
                ["Pronouns", person.pronouns],
              ].map(([label, value]) => (
                <div key={label as string} className="flex gap-3">
                  <dt className="w-20 shrink-0 text-dim">{label}</dt>
                  <dd className="text-strong">
                    {value || <span className="text-faint">Not set</span>}
                  </dd>
                </div>
              ))}
            </dl>

            {(links.linkedin || links.twitter || links.website) && (
              <div className="mt-3 space-y-1.5 border-t border-line-soft pt-3">
                {links.linkedin && <LinkRow label="LinkedIn" href={links.linkedin} />}
                {links.twitter && <LinkRow label="X / Twitter" href={links.twitter} />}
                {links.website && <LinkRow label="Website" href={links.website} />}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Sign-in link</h2>
            <p className="mt-1 text-[12px] text-dim">
              For the speaker who cannot find the email. One use, expires in{" "}
              {SIGN_IN_LINK_TTL_HOURS} hours, and signs them straight into
              their portal, so send it to them and nobody else.
            </p>
            {action?.signInLink ? (
              <div className="mt-2">
                <CopyLine text={action.signInLink} />
              </div>
            ) : (
              <Form method="post" className="mt-2">
                <input type="hidden" name="intent" value="signin_link" />
                <button
                  disabled={busy}
                  className="cb-btn cb-btn-secondary px-2.5 py-1.5 text-[13px]"
                >
                  Copy sign-in link
                </button>
              </Form>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Recent email</h2>
            {mail.length === 0 ? (
              <p className="mt-2 text-[13px] text-dim">
                Nothing sent to this address yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {mail.map((m) => (
                  <li key={m.id} className="text-[13px]">
                    <Link
                      to={`/admin/emails/${m.id}`}
                      className="text-strong underline-offset-2 hover:underline"
                    >
                      {m.subject}
                    </Link>
                    <div className="text-[12px] text-dim">
                      {m.templateKey} ·{" "}
                      {fmtDateIn(m.at, eventZone, {
                        day: "numeric",
                        month: "short",
                      })}{" "}
                      · {m.status}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Link
              to={`/admin/emails?q=${encodeURIComponent(person.email)}`}
              className="mt-2 inline-block text-[12px] text-accent-text underline-offset-2 hover:underline"
            >
              All email to this address
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
