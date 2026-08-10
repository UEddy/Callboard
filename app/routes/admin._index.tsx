import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  assignments,
  events,
  forms,
  participants,
  rooms,
  submissionParticipants,
  submissions,
  tasks,
  taskAssignments,
  tracks,
} from "~/db/schema";
import {
  detectConflicts,
  durationFor,
  eventDays,
  type Scheduled,
} from "~/lib/schedule";
import { dayIsoIn, safeZone } from "~/lib/tz";

/* ------------------------------------------------------------------ *
 * The dashboard.
 *
 * One screen, one loader, a fixed number of queries. No widgets to
 * arrange and nothing to configure, because a producer opening this at
 * 8am wants to know what is on fire, not to build a reporting tool.
 *
 * The nudges are the point. Each one is derived from real rows and each
 * disappears at zero, so an empty "also check" section is a genuine
 * signal that nothing needs attention rather than a section that is
 * always there and therefore always ignored.
 * ------------------------------------------------------------------ */

const RECENT_LIMIT = 8;

/* Today, in the event's own timezone rather than the server's. */
function localToday(zone: string) {
  return dayIsoIn(Date.now(), zone);
}

function daysBetween(fromIso: string, toIso: string) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export async function loader({ context }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  /* One pass over submissions supplies the counters, the status row, the
     scheduling gaps, the never-notified list and the recent table. */
  const subs = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      trackId: submissions.trackId,
      trackName: tracks.name,
      trackColor: tracks.color,
      roomId: submissions.roomId,
      roomName: rooms.name,
      startsAt: submissions.startsAt,
      endsAt: submissions.endsAt,
      submittedAt: submissions.submittedAt,
      decidedAt: submissions.decidedAt,
      notifiedAt: submissions.notifiedAt,
      createdAt: submissions.createdAt,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(eq(submissions.eventId, DEMO_EVENT_ID));

  const people = await db
    .select({
      submissionId: submissionParticipants.submissionId,
      id: participants.id,
      firstName: participants.firstName,
      lastName: participants.lastName,
      bio: participants.bio,
      headshotUrl: participants.headshotUrl,
    })
    .from(submissionParticipants)
    .innerJoin(
      participants,
      eq(submissionParticipants.participantId, participants.id),
    )
    .where(
      inArray(
        submissionParticipants.submissionId,
        subs.length ? subs.map((s) => s.id) : ["none"],
      ),
    );

  const speakersBy = new Map<string, typeof people>();
  for (const p of people) {
    const arr = speakersBy.get(p.submissionId) ?? [];
    arr.push(p);
    speakersBy.set(p.submissionId, arr);
  }

  const accepted = subs.filter((s) => s.status === "accepted");

  /* --- counters ---------------------------------------------------- */

  const byStatus: Record<string, number> = {};
  for (const s of subs) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

  const acceptedSpeakers = new Map<string, (typeof people)[number]>();
  for (const s of accepted) {
    for (const p of speakersBy.get(s.id) ?? []) {
      if (!acceptedSpeakers.has(p.id)) acceptedSpeakers.set(p.id, p);
    }
  }
  const speakerIds = [...acceptedSpeakers.keys()];

  const taskList = await db
    .select()
    .from(tasks)
    .where(eq(tasks.eventId, DEMO_EVENT_ID));

  const taskRows = speakerIds.length
    ? await db
        .select()
        .from(taskAssignments)
        .where(inArray(taskAssignments.participantId, speakerIds))
    : [];

  /* Matches the onboarding screen exactly: required tasks only, and a
     missing assignment row counts as not started rather than as absent. */
  const now = Date.now();
  let openTasks = 0;
  let overdueTasks = 0;
  for (const pid of speakerIds) {
    for (const t of taskList) {
      if (!t.required) continue;
      const a = taskRows.find(
        (x) => x.participantId === pid && x.taskId === t.id,
      );
      const status = a?.status ?? "not_started";
      const done = status === "complete" || status === "waived";
      if (!done) {
        openTasks++;
        const due = t.dueAt ? new Date(t.dueAt).getTime() : null;
        if (due !== null && due < now) overdueTasks++;
      }
    }
  }

  const needsSlot = accepted.filter((s) => !s.startsAt || !s.roomId);

  /* --- conflicts, using the agenda's own detector ------------------- */

  const scheduled: Scheduled[] = accepted
    .filter((s) => s.startsAt && s.roomId)
    .map((s) => {
      const startMs = new Date(s.startsAt!).getTime();
      return {
        id: s.id,
        ref: s.ref,
        title: s.title,
        roomId: s.roomId,
        startMs,
        endMs: s.endsAt
          ? new Date(s.endsAt).getTime()
          : startMs + durationFor(s.format) * 60_000,
        roomName: s.roomName,
        roomCapacity: null,
        trackId: s.trackId,
        trackName: s.trackName,
        trackColor: s.trackColor,
        format: s.format,
        speakers: (speakersBy.get(s.id) ?? []).map((p) => ({
          id: p.id,
          name: [p.firstName, p.lastName].filter(Boolean).join(" "),
        })),
      };
    });

  const conflicts = detectConflicts(
    scheduled,
    eventDays(event?.startsAt ?? null, event?.endsAt ?? null, safeZone(event?.timezone)),
    safeZone(event?.timezone),
  );

  /* --- remaining nudge inputs --------------------------------------- */

  const awaitingDecision = subs.filter(
    (s) => s.status === "pending" || s.status === "submitted",
  ).length;

  const neverNotified = subs.filter(
    (s) => (s.status === "accepted" || s.status === "declined") && !s.notifiedAt,
  ).length;

  const missingProfile = [...acceptedSpeakers.values()].filter(
    (p) => !p.bio?.trim() || !p.headshotUrl?.trim(),
  ).length;

  const reviewRows = await db
    .select({ submissionId: assignments.submissionId })
    .from(assignments);
  const reviewed = new Set(reviewRows.map((r) => r.submissionId));
  const unreviewed = subs.filter(
    (s) =>
      ["pending", "submitted", "accept_queue"].includes(s.status) &&
      !reviewed.has(s.id),
  ).length;

  const formRows = await db
    .select({
      id: forms.id,
      name: forms.name,
      status: forms.status,
      closeAt: forms.closeAt,
    })
    .from(forms)
    .where(eq(forms.eventId, DEMO_EVENT_ID));
  const staleForms = formRows.filter(
    (f) =>
      f.status === "open" && f.closeAt && new Date(f.closeAt).getTime() < now,
  ).length;

  const queuedDecisions = subs.filter((s) =>
    ["accept_queue", "decline_queue"].includes(s.status),
  ).length;

  /* --- recent table -------------------------------------------------- */

  /* Submitted things first, newest first. An untouched draft is not a
     recent submission and should not out-rank one just because its row
     was created a moment ago, so unsubmitted rows fall to the bottom. */
  const recent = [...subs]
    .sort((a, b) => {
      const at = a.submittedAt ? new Date(a.submittedAt).getTime() : null;
      const bt = b.submittedAt ? new Date(b.submittedAt).getTime() : null;
      if (at !== null && bt !== null) return bt - at;
      if (at !== null) return -1;
      if (bt !== null) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, RECENT_LIMIT)
    .map((s) => ({
      id: s.id,
      ref: s.ref,
      title: s.title,
      status: s.status,
      trackName: s.trackName,
      trackColor: s.trackColor,
      submittedAt: s.submittedAt ? new Date(s.submittedAt).getTime() : null,
      speakers: (speakersBy.get(s.id) ?? []).map((p) =>
        [p.firstName, p.lastName].filter(Boolean).join(" "),
      ),
    }));

  const zone = safeZone(event?.timezone);
  const today = localToday(zone);
  const eventStartDay = event?.startsAt
    ? dayIsoIn(new Date(event.startsAt).getTime(), zone)
    : null;

  return {
    eventName: event?.name ?? "Callboard",
    today,
    daysToEvent: eventStartDay ? daysBetween(today, eventStartDay) : null,
    counters: {
      submissions: subs.length,
      acceptedSpeakers: acceptedSpeakers.size,
      openTasks,
      needsSlot: needsSlot.length,
    },
    statuses: {
      accepted: byStatus.accepted ?? 0,
      pending: (byStatus.pending ?? 0) + (byStatus.submitted ?? 0),
      declined: byStatus.declined ?? 0,
      drafts: byStatus.draft ?? 0,
      withdrawn: byStatus.withdrawn ?? 0,
    },
    nudges: {
      needsSlot: needsSlot.length,
      awaitingDecision,
      missingProfile,
      neverNotified,
      conflicts: conflicts.length,
      queuedDecisions,
      unreviewed,
      overdueTasks,
      staleForms,
    },
    recent,
    ms: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ */

const STATUS_PILL: Record<string, string> = {
  accepted: "cb-pill-success",
  accept_queue: "cb-pill-success",
  pending: "cb-pill-warn",
  submitted: "cb-pill-warn",
  decline_queue: "cb-pill-danger",
  declined: "cb-pill-danger",
  draft: "cb-pill-neutral",
  withdrawn: "cb-pill-neutral",
};

const STATUS_LABEL: Record<string, string> = {
  accept_queue: "In accept queue",
  decline_queue: "In decline queue",
  submitted: "Pending",
};

function label(status: string) {
  return (
    STATUS_LABEL[status] ??
    status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")
  );
}

function ago(ms: number | null) {
  if (!ms) return "Not submitted";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function countdown(days: number | null, name: string) {
  if (days === null) return `${name} has no dates set yet.`;
  if (days > 1) return `${days} days until ${name}.`;
  if (days === 1) return `${name} starts tomorrow.`;
  if (days === 0) return `${name} starts today.`;
  return `${name} finished ${Math.abs(days)} days ago.`;
}

type Nudge = {
  when: boolean;
  tone: "danger" | "warn" | "accent";
  text: string;
  to: string;
  cta: string;
};

export default function Dashboard() {
  const { eventName, today, daysToEvent, counters, statuses, nudges, recent, ms } =
    useLoaderData<typeof loader>();

  const n = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;

  /* Ordered by how much damage each one does if ignored. */
  const list = ([
    {
      when: nudges.neverNotified > 0,
      tone: "danger",
      text: `${n(nudges.neverNotified, "submission has", "submissions have")} a decision on record but no email ever went out.`,
      to: "/admin/decisions",
      cta: "Send them",
    },
    {
      when: nudges.conflicts > 0,
      tone: "danger",
      text: `${n(nudges.conflicts, "scheduling conflict", "scheduling conflicts")} on the agenda: a double booked room, a speaker in two places, or a session outside event hours.`,
      to: "/admin/agenda?view=conflicts",
      cta: "Resolve",
    },
    {
      when: nudges.needsSlot > 0,
      tone: "warn",
      text: `${n(nudges.needsSlot, "accepted session has", "accepted sessions have")} no time slot yet.`,
      to: "/admin/agenda",
      cta: "Schedule",
    },
    {
      when: nudges.awaitingDecision > 0,
      tone: "warn",
      text: `${n(nudges.awaitingDecision, "submission is", "submissions are")} still waiting on a decision.`,
      to: "/admin/submissions?tab=pending",
      cta: "Review",
    },
    {
      when: nudges.queuedDecisions > 0,
      tone: "warn",
      text: `${n(nudges.queuedDecisions, "decision is", "decisions are")} staged but not committed, so nobody has been told.`,
      to: "/admin/decisions",
      cta: "Commit",
    },
    {
      when: nudges.missingProfile > 0,
      tone: "warn",
      text: `${n(nudges.missingProfile, "accepted speaker is", "accepted speakers are")} missing a bio or a headshot.`,
      to: "/admin/onboarding",
      cta: "Chase",
    },
    {
      when: nudges.overdueTasks > 0,
      tone: "warn",
      text: `${n(nudges.overdueTasks, "speaker task is", "speaker tasks are")} past their due date.`,
      to: "/admin/onboarding",
      cta: "Chase",
    },
    {
      when: nudges.unreviewed > 0,
      tone: "accent",
      text: `${n(nudges.unreviewed, "submission has", "submissions have")} no reviewer assigned.`,
      to: "/admin/evaluation?tab=results",
      cta: "Assign",
    },
    {
      when: nudges.staleForms > 0,
      tone: "accent",
      text: `${n(nudges.staleForms, "form is", "forms are")} marked open but past the deadline, so submitters see a closed form.`,
      to: "/admin/forms",
      cta: "Fix",
    },
  ] satisfies Nudge[]).filter((x) => x.when);

  const TONE: Record<Nudge["tone"], string> = {
    danger: "bg-danger-solid",
    warn: "bg-warn-solid",
    accent: "bg-accent-solid",
  };

  const cards = [
    { label: "Submissions", value: counters.submissions, to: "/admin/submissions" },
    { label: "Accepted speakers", value: counters.acceptedSpeakers, to: "/admin/onboarding" },
    { label: "Open speaker tasks", value: counters.openTasks, to: "/admin/onboarding" },
    { label: "Need a time slot", value: counters.needsSlot, to: "/admin/agenda" },
  ];

  const statusRow = [
    { label: "Accepted", value: statuses.accepted, tab: "accepted" },
    { label: "Pending", value: statuses.pending, tab: "pending" },
    { label: "Declined", value: statuses.declined, tab: "declined" },
    { label: "Drafts", value: statuses.drafts, tab: "drafts" },
    { label: "Withdrawn", value: statuses.withdrawn, tab: "withdrawn" },
  ];

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              {new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              })}
            </h1>
            <p className="mt-0.5 text-[13px] text-dim">
              {countdown(daysToEvent, eventName)}
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>
      </div>

      <div className="space-y-6 px-6 py-5">
        {/* Counters */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map((c) => (
            <Link
              key={c.label}
              to={c.to}
              prefetch="intent"
              className="rounded-lg border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong"
            >
              <div className="text-[26px] font-semibold tabular-nums text-strong">
                {c.value}
              </div>
              <div className="text-[12px] text-dim">{c.label}</div>
            </Link>
          ))}
        </div>

        {/* Status row */}
        <section>
          <h2 className="text-[13px] font-semibold tracking-tight">
            Submissions by status
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {statusRow.map((s) => (
              <Link
                key={s.tab}
                to={`/admin/submissions?tab=${s.tab}`}
                prefetch="intent"
                className="rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-line-strong"
              >
                <div className="text-[18px] font-semibold tabular-nums text-strong">
                  {s.value}
                </div>
                <div className="text-[12px] text-dim">{s.label}</div>
              </Link>
            ))}
          </div>
        </section>

        {/* Nudges */}
        <section>
          <h2 className="text-[13px] font-semibold tracking-tight">
            Also check
          </h2>
          {list.length === 0 ? (
            <div className="mt-2 rounded-lg border border-line bg-surface px-4 py-6 text-center">
              <p className="text-[13px] font-medium text-strong">
                Nothing needs attention.
              </p>
              <p className="mt-0.5 text-[12px] text-dim">
                Every decision has been sent, every accepted session has a slot,
                and no conflicts are outstanding.
              </p>
            </div>
          ) : (
            <ul className="mt-2 divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
              {list.map((x, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${TONE[x.tone]}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 text-[13px] text-strong">
                    {x.text}
                  </span>
                  <Link
                    to={x.to}
                    prefetch="intent"
                    className="shrink-0 text-[12px] font-medium text-accent-text underline-offset-2 hover:underline"
                  >
                    {x.cta}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent */}
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Recent submissions
            </h2>
            <Link
              to="/admin/submissions"
              prefetch="intent"
              className="text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
            >
              See all
            </Link>
          </div>

          <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
            {recent.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-dim">
                Nothing has come in yet.
              </p>
            ) : (
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="cb-thead text-[11px] uppercase tracking-[0.06em]">
                    <th className="px-4 py-2 font-medium">Ref</th>
                    <th className="px-4 py-2 font-medium">Title</th>
                    <th className="px-4 py-2 font-medium">Speakers</th>
                    <th className="px-4 py-2 font-medium">Track</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr
                      key={r.id}
                      className="cb-row-hover border-b border-line-soft last:border-0"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[12px] text-dim">
                        {r.ref}
                      </td>
                      <td className="max-w-xs px-4 py-2.5">
                        <Link
                          to={`/admin/submissions/${r.id}`}
                          prefetch="intent"
                          className="font-medium text-strong underline-offset-2 hover:text-accent-text hover:underline"
                        >
                          {r.title || "Untitled"}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {r.speakers.length === 0 ? (
                          <span className="text-faint">None yet</span>
                        ) : (
                          <>
                            {r.speakers[0]}
                            {r.speakers.length > 1 && (
                              <span className="text-faint">
                                {" "}
                                +{r.speakers.length - 1}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {r.trackName ? (
                          <span className="inline-flex items-center gap-1.5 text-body">
                            <span
                              className="cb-dot h-2 w-2"
                              style={
                                {
                                  "--cb-hue": r.trackColor ?? "#94a3b8",
                                } as React.CSSProperties
                              }
                            />
                            {r.trackName}
                          </span>
                        ) : (
                          <span className="text-faint">Unassigned</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span
                          className={`cb-pill ${STATUS_PILL[r.status] ?? "cb-pill-neutral"}`}
                        >
                          {label(r.status)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-dim">
                        {ago(r.submittedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
