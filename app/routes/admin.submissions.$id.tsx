import { useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  assignments,
  evaluationPlans,
  evaluatorConflicts,
  participants,
  rooms,
  submissionParticipants,
  submissions,
  scores,
  tags,
  tracks,
} from "~/db/schema";
import {
  isEditEntry,
  previewRoutingRules,
  type EditEntry,
  type TrailEntry,
} from "~/lib/routing";
import {
  computeEvaluationResults,
  createAssignments,
  criterionType,
  describeAssignment,
  isScored,
  type Criterion,
} from "~/lib/evaluation";

export async function loader({ context, params }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const row = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      description: submissions.description,
      status: submissions.status,
      format: submissions.format,
      level: submissions.level,
      answers: submissions.answers,
      tagIds: submissions.tagIds,
      routingTrail: submissions.routingTrail,
      submittedAt: submissions.submittedAt,
      decidedAt: submissions.decidedAt,
      notifiedAt: submissions.notifiedAt,
      startsAt: submissions.startsAt,
      trackName: tracks.name,
      trackColor: tracks.color,
      roomName: rooms.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(eq(submissions.id, params.id!))
    .then((r) => r[0]);

  if (!row) throw new Response("Submission not found", { status: 404 });

  const speakers = await db
    .select({
      id: participants.id,
      firstName: participants.firstName,
      lastName: participants.lastName,
      email: participants.email,
      company: participants.company,
      jobTitle: participants.jobTitle,
      role: submissionParticipants.role,
      isPrimary: submissionParticipants.isPrimary,
    })
    .from(submissionParticipants)
    .innerJoin(
      participants,
      eq(submissionParticipants.participantId, participants.id),
    )
    .where(eq(submissionParticipants.submissionId, row.id));

  const tagList = row.tagIds?.length
    ? await db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(tags)
        .where(inArray(tags.id, row.tagIds))
    : [];

  const assignmentRows = await db
    .select({
      id: assignments.id,
      planId: assignments.planId,
      participantId: assignments.participantId,
      submissionId: assignments.submissionId,
      round: assignments.round,
      status: assignments.status,
      planName: evaluationPlans.name,
      criteria: evaluationPlans.criteria,
      scaleMin: evaluationPlans.scaleMin,
      scaleMax: evaluationPlans.scaleMax,
      anonymize: evaluationPlans.anonymize,
      firstName: participants.firstName,
      lastName: participants.lastName,
      email: participants.email,
    })
    .from(assignments)
    .innerJoin(evaluationPlans, eq(assignments.planId, evaluationPlans.id))
    .innerJoin(participants, eq(assignments.participantId, participants.id))
    .where(eq(assignments.submissionId, row.id))
    .orderBy(asc(assignments.round), asc(assignments.id));

  const scoreRows = assignmentRows.length
    ? await db
        .select({
          assignmentId: scores.assignmentId,
          criterionKey: scores.criterionKey,
          value: scores.value,
          comment: scores.comment,
        })
        .from(scores)
        .where(
          inArray(
            scores.assignmentId,
            assignmentRows.map((a) => a.id),
          ),
        )
    : [];

  /* Same maths as the results table and the export, from the same
     module, so a score read here is the score this submission is ranked
     by. */
  const { totals, reviews: computed } = computeEvaluationResults({
    assignments: assignmentRows,
    scores: scoreRows,
    plans: assignmentRows.map((a) => ({
      id: a.planId,
      name: a.planName,
      criteria: a.criteria,
    })),
  });

  const byAssignment = new Map(computed.map((r) => [r.assignmentId, r]));

  const reviews = assignmentRows.map((a, i) => {
    const detail = byAssignment.get(a.id);
    const criteria = (a.criteria ?? []) as Criterion[];

    /* A blind plan means the committee's identities stay out of this,
       and out of the payload: withholding a name in the markup while
       shipping it in the page's own JSON would be a blindfold with a
       hole in it. The number keeps two reviewers on one submission
       distinguishable without saying who they are. */
    return {
      id: a.id,
      anonymous: a.anonymize,
      who: a.anonymize
        ? `Reviewer ${i + 1}`
        : [a.firstName, a.lastName].filter(Boolean).join(" ") || a.email,
      planName: a.planName,
      round: a.round,
      status: a.status,
      scaleMax: a.scaleMax,
      average: detail?.average ?? null,
      criteria: criteria.map((c) => {
        const value = detail?.values[c.key] ?? null;
        const kind = criterionType(c);
        return {
          key: c.key,
          name: c.name,
          weight: c.weight,
          type: kind,
          scored: isScored(c),
          value,
          /* A dropdown's number means nothing without the author's word
             for it, so the label is what gets shown. */
          label:
            kind === "dropdown" && value !== null
              ? ((c.options ?? []).find((o) => o.value === value)?.label ??
                String(value))
              : null,
          comment: detail?.comments[c.key] ?? null,
        };
      }),
    };
  });

  const totalsForRow = totals.get(row.id) ?? null;

  /* What the editor can choose from. Formats and levels are free text on
     the submission, so the datalist offers what this event already uses
     rather than a fixed list that would be wrong for somebody. */
  const [allTracks, allTags, admins, usedValues] = await Promise.all([
    db
      .select({ id: tracks.id, name: tracks.name, color: tracks.color })
      .from(tracks)
      .where(eq(tracks.eventId, DEMO_EVENT_ID))
      .orderBy(asc(tracks.sortOrder)),
    db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .where(eq(tags.eventId, DEMO_EVENT_ID))
      .orderBy(asc(tags.name)),
    db
      .select({
        id: participants.id,
        firstName: participants.firstName,
        lastName: participants.lastName,
        email: participants.email,
      })
      .from(participants)
      .where(
        and(
          eq(participants.eventId, DEMO_EVENT_ID),
          eq(participants.isAdmin, true),
        ),
      ),
    db
      .select({ format: submissions.format, level: submissions.level })
      .from(submissions)
      .where(eq(submissions.eventId, DEMO_EVENT_ID)),
  ]);

  /* Who could review this, and what they are already carrying. Load is
     the number that decides it: a producer staffing a submission is
     choosing between people, and "4 assigned, 1 done" is the whole
     basis for that choice. */
  const [evaluatorRows, loadRows, conflictRows, planList] = await Promise.all([
    db
      .select({
        id: participants.id,
        firstName: participants.firstName,
        lastName: participants.lastName,
        email: participants.email,
        company: participants.company,
      })
      .from(participants)
      .where(
        and(
          eq(participants.eventId, DEMO_EVENT_ID),
          eq(participants.isEvaluator, true),
        ),
      ),
    db
      .select({
        participantId: assignments.participantId,
        submissionId: assignments.submissionId,
        status: assignments.status,
      })
      .from(assignments),
    db
      .select({ participantId: evaluatorConflicts.participantId })
      .from(evaluatorConflicts)
      .where(eq(evaluatorConflicts.submissionId, row.id)),
    db
      .select({ id: evaluationPlans.id, name: evaluationPlans.name })
      .from(evaluationPlans)
      .where(eq(evaluationPlans.eventId, DEMO_EVENT_ID)),
  ]);

  const conflicted = new Set(conflictRows.map((c) => c.participantId));
  const candidates = evaluatorRows
    .map((e) => {
      const mine = loadRows.filter((a) => a.participantId === e.id);
      return {
        id: e.id,
        name: [e.firstName, e.lastName].filter(Boolean).join(" ") || e.email,
        company: e.company,
        assigned: mine.length,
        complete: mine.filter((a) => a.status === "complete").length,
        onThis: mine.some((a) => a.submissionId === row.id),
        conflict: conflicted.has(e.id),
      };
    })
    .sort((a, b) => a.assigned - b.assigned || a.name.localeCompare(b.name));

  return {
    row,
    speakers,
    tagList,
    candidates,
    plans: planList,
    allTracks,
    allTags,
    admins: admins.map((a) => ({
      id: a.id,
      name: [a.firstName, a.lastName].filter(Boolean).join(" ") || a.email,
    })),
    formats: [...new Set(usedValues.map((v) => v.format).filter(Boolean))].sort(),
    levels: [...new Set(usedValues.map((v) => v.level).filter(Boolean))].sort(),
    reviews,
    score: {
      average: totalsForRow?.average ?? null,
      reviews: totalsForRow?.reviews ?? 0,
      assigned: totalsForRow?.assigned ?? 0,
      complete: totalsForRow?.complete ?? 0,
    },
    ms: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ *
 * Editing a submission by hand.
 *
 * Routing deliberately does not re-run. A rule fired once, at submit
 * time, on what the submitter wrote; a producer changing a format
 * afterwards is making a decision, and having that decision silently
 * reassign the review committee would be the opposite of one. What the
 * rules would have done is worked out anyway and reported, so the
 * producer can act on it themselves.
 * ------------------------------------------------------------------ */

export async function action({ context, params, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const id = params.id!;
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  /* The same operation as the Evaluators tab's Assign, read from the
     other end: a producer looking at a submission staffs it, rather than
     going to find each reviewer. Shared implementation, so the conflict
     rule cannot hold on one screen and not the other. */
  if (intent === "assign_reviewers") {
    const planId = String(fd.get("planId") ?? "");
    const participantIds = (fd.getAll("participantIds") as string[]).filter(
      Boolean,
    );

    const plan = await db.query.evaluationPlans.findFirst({
      where: and(
        eq(evaluationPlans.id, planId),
        eq(evaluationPlans.eventId, DEMO_EVENT_ID),
      ),
    });
    if (!plan) return { error: "Pick a plan to assign under." };
    if (!participantIds.length) return { error: "Pick at least one reviewer." };

    const result = await createAssignments(db, {
      planId,
      pairs: participantIds.map((participantId) => ({
        participantId,
        submissionId: id,
      })),
    });

    return { saved: `${describeAssignment(result)} Under ${plan.name}.` };
  }

  if (intent !== "save_content") {
    return { error: "Unknown action." };
  }

  const before = await db.query.submissions.findFirst({
    where: eq(submissions.id, id),
  });
  if (!before) throw new Response("Submission not found", { status: 404 });

  const [trackList, tagList] = await Promise.all([
    db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.eventId, DEMO_EVENT_ID)),
    db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.eventId, DEMO_EVENT_ID)),
  ]);
  const trackName = new Map(trackList.map((t) => [t.id, t.name]));
  const tagName = new Map(tagList.map((t) => [t.id, t.name]));

  const title = String(fd.get("title") ?? "").trim();
  if (!title) return { error: "A submission needs a title." };

  const rawTrack = String(fd.get("trackId") ?? "");
  const trackId = rawTrack && trackName.has(rawTrack) ? rawTrack : null;
  const tagIds = (fd.getAll("tagIds") as string[]).filter((t) => tagName.has(t));

  const next = {
    title,
    description: String(fd.get("description") ?? "").trim() || null,
    format: String(fd.get("format") ?? "").trim() || null,
    level: String(fd.get("level") ?? "").trim() || null,
    trackId,
    tagIds,
  };

  /* Who did it. There is no admin sign-in in Callboard, so the editor
     names themselves from the event's admins, the same convention the
     evaluation screen uses for "Reviewing as". An unrecognised id is
     rejected rather than written into the history as fact. */
  const editorId = String(fd.get("editorId") ?? "");
  const editor = editorId
    ? await db.query.participants.findFirst({
        where: and(
          eq(participants.id, editorId),
          eq(participants.eventId, DEMO_EVENT_ID),
        ),
      })
    : null;
  if (!editor) return { error: "Say who is making the change." };

  const nameOf = (ids: string[]) =>
    ids
      .map((t) => tagName.get(t) ?? t)
      .sort()
      .join(", ");

  const changes: { field: string; from: string; to: string }[] = [];
  const note = (field: string, from: string, to: string) => {
    if (from !== to) changes.push({ field, from, to });
  };

  note("Title", before.title ?? "", next.title);
  note("Description", plain(before.description), plain(next.description));
  note("Format", before.format ?? "", next.format ?? "");
  note("Level", before.level ?? "", next.level ?? "");
  note(
    "Track",
    before.trackId ? (trackName.get(before.trackId) ?? "") : "",
    next.trackId ? (trackName.get(next.trackId) ?? "") : "",
  );
  note("Tags", nameOf(before.tagIds ?? []), nameOf(next.tagIds));

  if (changes.length === 0) {
    return { saved: "Nothing changed." };
  }

  /* Worked out on the values about to be saved, and never applied. */
  const wouldFire = await previewRoutingRules(db, {
    eventId: DEMO_EVENT_ID,
    formId: before.formId,
    submission: {
      ...next,
      answers: before.answers as Record<string, unknown> | null,
    },
  });

  const entry: EditEntry = {
    kind: "edit",
    at: new Date().toISOString(),
    byId: editor.id,
    byName:
      [editor.firstName, editor.lastName].filter(Boolean).join(" ") ||
      editor.email,
    changes,
    ...(wouldFire.length
      ? {
          suppressed: wouldFire.map((r) => ({
            condition: r.condition,
            setTrack: r.wouldSetTrack,
            addedTags: r.wouldAddTags,
            plan: r.wouldAssignPlan,
          })),
        }
      : {}),
  };

  const trail = [
    ...((before.routingTrail ?? []) as TrailEntry[]),
    entry,
  ] as never;

  await db
    .update(submissions)
    .set({ ...next, routingTrail: trail, updatedAt: new Date() })
    .where(eq(submissions.id, id));

  return {
    saved: `Saved ${changes.length} change${changes.length === 1 ? "" : "s"}.`,
    wouldFire: wouldFire.map((r: Awaited<ReturnType<typeof previewRoutingRules>>[number]) => ({
      condition: r.condition,
      setTrack: r.wouldSetTrack,
      addedTags: r.wouldAddTags,
      plan: r.wouldAssignPlan,
      reviewers: r.wouldAssignReviewers,
    })),
  };
}

/* The trail records what a reader sees, so HTML from the editor is
   flattened before it is compared or stored as a before-and-after. */
function plain(html: string | null) {
  return (html ?? "").replace(/<[^>]+>/g, "").trim();
}

/* A history entry is a line in a list, not the document. A rewritten
   abstract is recorded in full but read at a glance. */
const editField =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong";

function truncate(value: string, limit = 90) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

const STATUS_STYLE: Record<string, string> = {
  accepted: "bg-success-soft text-success ring-success-ring",
  accept_queue: "bg-success-soft text-success ring-success-ring",
  pending: "bg-warn-soft text-warn ring-warn-ring",
  submitted: "bg-warn-soft text-warn ring-warn-ring",
  decline_queue: "bg-danger-soft text-danger ring-danger-ring",
  declined: "bg-danger-soft text-danger ring-danger-ring",
  draft: "bg-muted text-body ring-line",
  withdrawn: "bg-muted text-dim ring-line",
};

function fmt(d: string | number | Date | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function SubmissionDetail() {
  const {
    row,
    speakers,
    tagList,
    candidates,
    plans,
    allTracks,
    allTags,
    admins,
    formats,
    levels,
    reviews,
    score,
    ms,
  } = useLoaderData<typeof loader>();
  const action = useActionData<{
    saved?: string;
    error?: string;
    wouldFire?: {
      condition: string;
      setTrack?: string;
      addedTags?: string[];
      plan?: string;
      reviewers?: number;
    }[];
  }>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [editing, setEditing] = useState(false);
  const trail = (row.routingTrail ?? []) as TrailEntry[];

  const answers = Object.entries(
    (row.answers ?? {}) as Record<string, unknown>,
  ).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "");

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div className="min-w-0">
            <Link
              to="/admin/submissions"
              className="text-[12px] text-dim underline-offset-2 hover:underline"
            >
              Submissions
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] text-faint">
                {row.ref}
              </span>
              <h1 className="text-[19px] font-semibold tracking-tight">
                {row.title || "Untitled"}
              </h1>
              <span
                className={[
                  "rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                  STATUS_STYLE[row.status] ?? STATUS_STYLE.draft,
                ].join(" ")}
              >
                {row.status.replace(/_/g, " ")}
              </span>
            </div>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim" title="Time spent in this page's loader fetching data. It excludes rendering, so it is not total server time: that is in the Server-Timing response header.">
            data {ms} ms
          </div>
        </div>
      </div>

      <div className="grid gap-4 px-6 py-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
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
          {/* The whole point of not re-running routing is that the
              producer stays in charge, which only works if they are told
              what the rules would have done. */}
          {action?.wouldFire?.map((r, i) => (
            <p
              key={i}
              className="cb-note cb-note-warn px-3 py-2.5 text-[13px]"
            >
              Now that {r.condition}, a routing rule would have{" "}
              {[
                r.setTrack && `set the track to ${r.setTrack}`,
                r.addedTags?.length && `tagged it ${r.addedTags.join(", ")}`,
                r.plan &&
                  `sent it to ${r.plan}${typeof r.reviewers === "number" ? ` with ${r.reviewers} reviewers` : ""}`,
              ]
                .filter(Boolean)
                .join(", ")}
              . Editing does not re-run routing, so none of that happened. Do
              it yourself if you want it.
            </p>
          ))}

          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-semibold">Proposal</h2>
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                className="text-[12px] text-accent-text underline-offset-2 hover:underline"
              >
                {editing ? "Cancel" : "Edit"}
              </button>
            </div>

            {!editing ? (
              <div className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-body">
                {row.description?.replace(/<[^>]+>/g, "") || "No description."}
              </div>
            ) : (
              <Form method="post" className="mt-3 space-y-3">
                <input type="hidden" name="intent" value="save_content" />

                <label className="block">
                  <span className="text-[13px] font-medium">Title</span>
                  <input
                    name="title"
                    defaultValue={row.title}
                    className={editField}
                  />
                </label>

                <label className="block">
                  <span className="text-[13px] font-medium">Description</span>
                  {/* A submitter's description can arrive as HTML from a
                      rich text field. This box is plain text, so saying
                      so beats a producer discovering their bold went
                      missing after they saved. */}
                  {/<[a-z][^>]*>/i.test(row.description ?? "") && (
                    <span className="block text-[12px] text-warn">
                      This description was written with formatting. Editing it
                      here saves plain text, so any formatting is lost.
                    </span>
                  )}
                  <textarea
                    name="description"
                    rows={8}
                    defaultValue={row.description?.replace(/<[^>]+>/g, "") ?? ""}
                    className={editField}
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-[13px] font-medium">Format</span>
                    <input
                      name="format"
                      list="format-options"
                      defaultValue={row.format ?? ""}
                      className={editField}
                    />
                    <datalist id="format-options">
                      {formats.map((f) => (
                        <option key={f} value={f!} />
                      ))}
                    </datalist>
                  </label>
                  <label className="block">
                    <span className="text-[13px] font-medium">Level</span>
                    <input
                      name="level"
                      list="level-options"
                      defaultValue={row.level ?? ""}
                      className={editField}
                    />
                    <datalist id="level-options">
                      {levels.map((l) => (
                        <option key={l} value={l!} />
                      ))}
                    </datalist>
                  </label>
                  <label className="block">
                    <span className="text-[13px] font-medium">Track</span>
                    <select
                      name="trackId"
                      defaultValue={
                        allTracks.find((t) => t.name === row.trackName)?.id ?? ""
                      }
                      className={editField}
                    >
                      <option value="">No track</option>
                      {allTracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <fieldset className="rounded-md border border-line-soft p-3">
                  <legend className="px-1 text-[12px] font-medium text-dim">
                    Tags
                  </legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {allTags.length === 0 && (
                      <span className="text-[12px] text-dim">
                        No tags defined in the library yet.
                      </span>
                    )}
                    {allTags.map((t) => (
                      <label
                        key={t.id}
                        className="flex items-center gap-1.5 text-[13px]"
                      >
                        <input
                          type="checkbox"
                          name="tagIds"
                          value={t.id}
                          defaultChecked={tagList.some((x) => x.id === t.id)}
                          className="h-4 w-4 rounded border-line-strong"
                        />
                        <span
                          className="cb-chip"
                          style={{ ["--cb-hue"]: t.color } as React.CSSProperties}
                        >
                          {t.name}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="text-[13px] font-medium">Editing as</span>
                    <span className="block text-[12px] text-dim">
                      Recorded in the history below.
                    </span>
                    <select name="editorId" className={editField}>
                      {admins.length === 0 && (
                        <option value="">Nobody is marked as an admin</option>
                      )}
                      {admins.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={busy || admins.length === 0}
                    className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
                  >
                    {busy ? "Saving" : "Save changes"}
                  </button>
                  <span className="text-[12px] text-dim">
                    Saving does not re-run routing rules.
                  </span>
                </div>
              </Form>
            )}
          </section>

          {answers.length > 0 && (
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-[13px] font-semibold">Form answers</h2>
              <dl className="mt-2 space-y-2">
                {answers.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[12px] text-dim">{k}</dt>
                    <dd className="whitespace-pre-wrap text-[13px] text-strong">
                      {String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* Routing trail: the reason this submission is where it is. */}
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">What happened to this</h2>
            <p className="mt-0.5 text-[12px] text-dim">
              Rules that fired when it was submitted, and every edit since.
            </p>

            {trail.length === 0 ? (
              <p className="mt-3 text-[13px] text-dim">
                No routing rules matched and nobody has edited it. Anything set
                on this submission was chosen by the submitter.
              </p>
            ) : (
              <ol className="mt-3 space-y-2">
                {trail.map((t, i) =>
                  isEditEntry(t) ? (
                    <li
                      key={`edit-${i}`}
                      className="rounded-md border border-line bg-subtle px-3 py-2"
                    >
                      <div className="text-[13px] text-strong">
                        <span className="font-medium">{t.byName}</span> edited
                        this
                      </div>
                      <ul className="mt-1 space-y-0.5 text-[12px] text-body">
                        {t.changes.map((c) => (
                          <li key={c.field}>
                            <span className="text-dim">{c.field}</span>{" "}
                            {c.from ? (
                              <>
                                <span className="line-through decoration-faint">
                                  {truncate(c.from)}
                                </span>{" "}
                                &rarr;{" "}
                              </>
                            ) : (
                              <span className="text-dim">set to </span>
                            )}
                            <span className="font-medium text-strong">
                              {c.to ? truncate(c.to) : "nothing"}
                            </span>
                          </li>
                        ))}
                        {t.suppressed?.map((sp, j) => (
                          <li key={`sup-${j}`} className="text-warn">
                            After this, {sp.condition} matched a routing rule
                            that would have{" "}
                            {[
                              sp.setTrack && `set the track to ${sp.setTrack}`,
                              sp.addedTags?.length &&
                                `tagged it ${sp.addedTags.join(", ")}`,
                              sp.plan && `sent it to ${sp.plan}`,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                            . An edit does not re-run routing, so nothing was
                            applied.
                          </li>
                        ))}
                      </ul>
                      <div className="mt-1 font-mono text-[10px] text-faint">
                        {fmt(t.at)}
                      </div>
                    </li>
                  ) : (
                  <li
                    key={`${t.ruleId}-${i}`}
                    className="rounded-md border border-line bg-subtle px-3 py-2"
                  >
                    <div className="text-[13px] text-strong">
                      Because <span className="font-medium">{t.condition}</span>
                    </div>
                    <ul className="mt-1 space-y-0.5 text-[12px] text-body">
                      {t.setTrack && (
                        <li>
                          Track set to{" "}
                          <span className="font-medium text-strong">
                            {t.setTrack}
                          </span>
                        </li>
                      )}
                      {t.addedTags?.length ? (
                        <li>
                          Tagged{" "}
                          <span className="font-medium text-strong">
                            {t.addedTags.join(", ")}
                          </span>
                        </li>
                      ) : null}
                      {t.plan && (
                        <li>
                          Sent to{" "}
                          <span className="font-medium text-strong">
                            {t.plan}
                          </span>
                          {typeof t.reviewers === "number" &&
                            ` with ${t.reviewers} reviewer${t.reviewers === 1 ? "" : "s"} assigned`}
                        </li>
                      )}
                      {t.notify?.length ? (
                        <li className="text-dim">
                          Rule lists {t.notify.join(", ")} for notification.
                          Rule driven email is not wired up, so nothing was
                          sent.
                        </li>
                      ) : null}
                    </ul>
                    <div className="mt-1 font-mono text-[10px] text-faint">
                      {t.ruleId} · {fmt(t.appliedAt)}
                    </div>
                  </li>
                  ),
                )}
              </ol>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Details</h2>
            <dl className="mt-2 space-y-1.5 text-[13px]">
              {[
                [
                  "Track",
                  row.trackName ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="cb-dot h-2 w-2"
                        style={{ ["--cb-hue"]: row.trackColor ?? "#94a3b8" } as React.CSSProperties}
                      />
                      {row.trackName}
                    </span>
                  ) : null,
                ],
                ["Format", row.format],
                ["Level", row.level],
                ["Room", row.roomName],
                ["Submitted", fmt(row.submittedAt)],
                ["Decided", fmt(row.decidedAt)],
                ["Notified", fmt(row.notifiedAt)],
              ].map(([label, value]) => (
                <div key={label as string} className="flex gap-3">
                  <dt className="w-20 shrink-0 text-dim">{label}</dt>
                  <dd className="text-strong">
                    {value || <span className="text-faint">Not set</span>}
                  </dd>
                </div>
              ))}
            </dl>

            {tagList.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {tagList.map((t) => (
                  <span
                    key={t.id}
                    className="cb-chip"
                    style={{ ["--cb-hue"]: t.color } as React.CSSProperties}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">
              Speakers{" "}
              <span className="font-normal text-faint">
                {speakers.length}
              </span>
            </h2>
            <ul className="mt-2 space-y-2">
              {speakers.map((s) => (
                <li key={s.id} className="text-[13px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-strong">
                      {[s.firstName, s.lastName].filter(Boolean).join(" ") ||
                        s.email}
                    </span>
                    <span
                      className={`cb-pill ${s.isPrimary ? "cb-pill-accent" : "cb-pill-neutral"}`}
                    >
                      {s.isPrimary ? `Primary ${s.role}` : s.role}
                    </span>
                  </div>
                  <div className="text-[12px] text-dim">
                    {[s.jobTitle, s.company].filter(Boolean).join(", ") ||
                      s.email}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-semibold">
                Review{" "}
                <span className="font-normal text-faint">{reviews.length}</span>
              </h2>
              {score.average !== null && (
                <span
                  className="text-[13px] font-semibold tabular-nums text-strong"
                  title={`Mean of ${score.reviews} reviewer${score.reviews === 1 ? "" : "s"}, each weighted by their plan's criteria`}
                >
                  {score.average.toFixed(2)}
                  <span className="font-normal text-dim"> weighted</span>
                </span>
              )}
            </div>

            {/* Staffing from this end, so a producer reading a proposal
                can put people on it without going to find each one. */}
            <details className="mt-2" open={reviews.length === 0}>
              <summary className="cursor-pointer text-[12px] text-accent-text hover:underline">
                Assign reviewers
              </summary>
              <Form method="post" className="mt-2 space-y-2">
                <input type="hidden" name="intent" value="assign_reviewers" />
                <select
                  name="planId"
                  defaultValue={plans[0]?.id ?? ""}
                  aria-label="Plan to assign under"
                  className={editField}
                >
                  {plans.length === 0 && <option value="">No plans yet</option>}
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <ul className="space-y-1">
                  {candidates.length === 0 && (
                    <li className="text-[12px] text-dim">
                      Nobody is marked as an evaluator yet.
                    </li>
                  )}
                  {candidates.map((c) => {
                    const blocked = c.onThis || c.conflict;
                    return (
                      <li key={c.id}>
                        <label
                          className={[
                            "flex items-baseline gap-2 rounded px-1 py-1 text-[13px]",
                            blocked ? "opacity-60" : "hover:bg-subtle",
                          ].join(" ")}
                        >
                          <input
                            type="checkbox"
                            name="participantIds"
                            value={c.id}
                            disabled={blocked}
                            className="h-4 w-4 shrink-0 rounded border-line-strong"
                          />
                          <span className="min-w-0 flex-1 text-strong">
                            {c.name}
                          </span>
                          <span
                            className="shrink-0 text-[12px] tabular-nums text-dim"
                            title="Reviews assigned, and how many are done"
                          >
                            {c.complete}/{c.assigned}
                          </span>
                          {c.conflict && (
                            <span className="cb-pill cb-pill-warn shrink-0">
                              conflict
                            </span>
                          )}
                          {c.onThis && !c.conflict && (
                            <span className="cb-pill cb-pill-neutral shrink-0">
                              on this
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>

                <button
                  disabled={busy || plans.length === 0}
                  className="cb-btn cb-btn-secondary px-2.5 py-1 text-[12px]"
                >
                  {busy ? "Assigning" : "Assign selected"}
                </button>
              </Form>
            </details>

            {reviews.length === 0 ? (
              <p className="mt-3 text-[13px] text-dim">
                Not assigned for review.
              </p>
            ) : (
              <>
                <p className="mt-0.5 text-[12px] text-dim">
                  {score.complete} of {score.assigned} complete ·{" "}
                  {[...new Set(reviews.map((r) => r.planName))].join(", ")}
                </p>

                <ul className="mt-3 space-y-3">
                  {reviews.map((r) => (
                    <li
                      key={r.id}
                      className="rounded-md border border-line-soft bg-subtle p-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[13px] font-medium text-strong">
                          {r.who}
                          {r.anonymous && (
                            <span
                              className="ml-1.5 cb-pill cb-pill-neutral"
                              title="This plan is scored blind, so who reviewed it is not shown"
                            >
                              blind
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[12px] tabular-nums text-dim">
                          {r.average === null ? r.status : r.average.toFixed(2)}
                        </span>
                      </div>

                      {r.average === null ? (
                        <p className="mt-1 text-[12px] text-dim">
                          {r.status === "skipped"
                            ? "Skipped this one."
                            : "Not scored yet."}
                        </p>
                      ) : (
                        <dl className="mt-1.5 space-y-1">
                          {r.criteria.map((c) => (
                            <div key={c.key}>
                              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                                <dt className="text-dim">
                                  {c.name}
                                  <span className="text-faint">
                                    {c.scored ? ` ·${c.weight}` : " · not scored"}
                                  </span>
                                </dt>
                                <dd className="shrink-0 text-strong">
                                  {!c.scored ? null : c.value === null ? (
                                    <span className="text-faint">not scored</span>
                                  ) : c.label ? (
                                    <>
                                      {c.label}
                                      <span className="text-faint tabular-nums">
                                        {" "}
                                        ({c.value})
                                      </span>
                                    </>
                                  ) : (
                                    <span className="tabular-nums">
                                      {c.value}
                                      <span className="text-faint">
                                        /{r.scaleMax}
                                      </span>
                                    </span>
                                  )}
                                </dd>
                              </div>
                              {/* The comment is the part a producer
                                  actually needs when a decision is
                                  argued about, so it is shown in full
                                  rather than behind a hover. */}
                              {c.comment && (
                                <p className="mt-0.5 whitespace-pre-wrap border-l-2 border-line pl-2 text-[12px] leading-relaxed text-body">
                                  {c.comment}
                                </p>
                              )}
                            </div>
                          ))}
                        </dl>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
