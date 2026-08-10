/* ------------------------------------------------------------------ *
 * The submissions list, shared by /admin/submissions, /admin/abstracts
 * and /admin/sessions.
 *
 * The three screens differ by exactly one thing: which submission kind
 * they are scoped to. Everything else, the tabs, the search, the track
 * filter, the columns and the inline status editing, is the same code,
 * so the abstracts view cannot quietly drift from the sessions view.
 * ------------------------------------------------------------------ */

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { DEMO_EVENT_ID } from "~/db/client";
import {
  events,
  participants,
  submissionParticipants,
  submissions,
  tracks,
} from "~/db/schema";
import type { getDb } from "~/db/client";
import { safeZone } from "~/lib/tz";
import { readViewerZone } from "~/lib/viewer-tz";

type Db = ReturnType<typeof getDb>;

/* Tabs mirror the real decision workflow: accept_queue and
   decline_queue are staging states, so a producer can batch decisions
   and review them before anything is committed or emailed. */
export const TABS = [
  { key: "all", label: "All", statuses: null },
  { key: "pending", label: "Pending", statuses: ["pending", "submitted"] },
  { key: "accept_queue", label: "Accept queue", statuses: ["accept_queue"] },
  { key: "accepted", label: "Accepted", statuses: ["accepted"] },
  { key: "decline_queue", label: "Decline queue", statuses: ["decline_queue"] },
  { key: "declined", label: "Declined", statuses: ["declined"] },
  { key: "drafts", label: "Drafts", statuses: ["draft"] },
  { key: "withdrawn", label: "Withdrawn", statuses: ["withdrawn"] },
] as const;

/* The eight the inline editor offers, in workflow order rather than
   alphabetical, so the list reads like the process it describes. */
export const ALL_STATUSES = [
  "draft",
  "pending",
  "accept_queue",
  "accepted",
  "decline_queue",
  "declined",
  "withdrawn",
  "submitted",
] as const;

/* Setting one of these means a decision exists. Nothing is emailed:
   sending lives on the decisions screen, and the list says so. */
export const DECIDED_STATUSES = ["accepted", "declined"];
export const QUEUE_STATUSES = ["accept_queue", "decline_queue"];

export const STATUS_STYLE: Record<string, string> = {
  accepted: "bg-success-soft text-success ring-success-ring",
  accept_queue: "bg-success-soft text-success ring-success-ring",
  pending: "bg-warn-soft text-warn ring-warn-ring",
  submitted: "bg-warn-soft text-warn ring-warn-ring",
  decline_queue: "bg-danger-soft text-danger ring-danger-ring",
  declined: "bg-danger-soft text-danger ring-danger-ring",
  draft: "bg-muted text-body ring-line",
  withdrawn: "bg-muted text-dim ring-line",
};

const STATUS_LABEL: Record<string, string> = {
  accept_queue: "In accept queue",
  decline_queue: "In decline queue",
  submitted: "Pending",
};

export function statusLabel(status: string) {
  return (
    STATUS_LABEL[status] ??
    status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")
  );
}

export type Kind = "abstracts" | "sessions" | null;

export async function loadSubmissionList(
  db: Db,
  request: Request,
  kind: Kind,
) {
  const started = Date.now();
  const url = new URL(request.url);

  const tabKey = url.searchParams.get("tab") ?? "all";
  const q = (url.searchParams.get("q") ?? "").trim();
  const trackFilter = url.searchParams.get("track") ?? "";
  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[0];

  const kindFilter = kind ? eq(submissions.kind, kind) : undefined;

  const where = and(
    eq(submissions.eventId, DEMO_EVENT_ID),
    kindFilter,
    tab.statuses ? inArray(submissions.status, [...tab.statuses]) : undefined,
    q ? like(submissions.title, `%${q}%`) : undefined,
    trackFilter ? eq(submissions.trackId, trackFilter) : undefined,
  );

  /* One query for counts across every tab, so the badges stay honest
     without eight round trips. Scoped to the same kind as the list. */
  const countRows = await db
    .select({ status: submissions.status, n: sql<number>`count(*)` })
    .from(submissions)
    .where(and(eq(submissions.eventId, DEMO_EVENT_ID), kindFilter))
    .groupBy(submissions.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of countRows) {
    byStatus[r.status] = Number(r.n);
    total += Number(r.n);
  }

  const rows = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      level: submissions.level,
      trackName: tracks.name,
      trackColor: tracks.color,
      submittedAt: submissions.submittedAt,
      notifiedAt: submissions.notifiedAt,
      decidedAt: submissions.decidedAt,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .where(where)
    .orderBy(desc(submissions.refSeq));

  // Speakers in one follow-up query rather than N joins per row.
  const ids = rows.map((r) => r.id);
  const speakerRows = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          firstName: participants.firstName,
          lastName: participants.lastName,
          company: participants.company,
          role: submissionParticipants.role,
          isPrimary: submissionParticipants.isPrimary,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
    : [];

  const speakersBySubmission: Record<
    string,
    { name: string; company: string | null; role: string; isPrimary: boolean }[]
  > = {};
  for (const s of speakerRows) {
    (speakersBySubmission[s.submissionId] ??= []).push({
      name: [s.firstName, s.lastName].filter(Boolean).join(" ") || "Unnamed",
      company: s.company,
      role: s.role,
      isPrimary: s.isPrimary,
    });
  }
  for (const list of Object.values(speakersBySubmission)) {
    list.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  }

  const ev = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  const trackList = await db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, DEMO_EVENT_ID))
    .orderBy(tracks.sortOrder);

  const tabCounts = TABS.map((t) => ({
    key: t.key,
    n: t.statuses
      ? t.statuses.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0)
      : total,
  }));

  return {
    rows,
    kind,
    eventZone: safeZone(ev?.timezone),
    viewerZone: await readViewerZone(request),
    speakersBySubmission,
    trackList,
    tabCounts,
    tabKey: tab.key,
    q,
    trackFilter,
    ms: Date.now() - started,
  };
}

/* Inline status change. Deliberately the whole of it: no email, no task
   creation, no calendar invite. Sending is the decisions screen's job,
   and a list that quietly emailed someone because a pill was clicked
   would be the worst kind of surprise. */
export async function setSubmissionStatus(
  db: Db,
  submissionId: string,
  next: string,
) {
  if (!(ALL_STATUSES as readonly string[]).includes(next)) {
    return { ok: false as const, error: "Unknown status." };
  }

  const current = await db.query.submissions.findFirst({
    where: eq(submissions.id, submissionId),
  });
  if (!current) return { ok: false as const, error: "Submission not found." };

  const patch: Record<string, unknown> = { status: next, updatedAt: new Date() };

  /* Record when the decision was taken, but never touch notifiedAt: the
     gap between the two is what makes the "Not sent" flag and the
     dashboard nudge fire, which is exactly the state we want a producer
     to be nagged about. */
  if (DECIDED_STATUSES.includes(next) && !current.decidedAt) {
    patch.decidedAt = new Date();
  }

  await db.update(submissions).set(patch).where(eq(submissions.id, submissionId));
  return { ok: true as const, status: next };
}
