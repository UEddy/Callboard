/* ------------------------------------------------------------------ *
 * Onboarding tasks: who a task applies to, and keeping assignments in
 * step with that.
 *
 * One assignment per person per task, never one per submission. A
 * speaker with two accepted sessions is still one human who has to
 * upload one headshot, and the onboarding board looks up an assignment
 * by (participant, task) and takes the first match. Generating a row
 * per submission would show them one tick while counting two.
 * ------------------------------------------------------------------ */

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  participants,
  submissionParticipants,
  submissions,
  taskAssignments,
  tasks,
} from "~/db/schema";
import type { getDb } from "~/db/client";

type Db = ReturnType<typeof getDb>;

export const TASK_KINDS = [
  { value: "upload_headshot", label: "Upload headshot" },
  { value: "upload_slides", label: "Upload slides" },
  { value: "confirm_bio", label: "Confirm bio" },
  { value: "sign_release", label: "Sign release" },
  { value: "confirm_attendance", label: "Confirm attendance" },
  { value: "custom", label: "Custom" },
] as const;

export function kindLabel(kind: string) {
  return TASK_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/* appliesTo is a small tagged string rather than three columns, because
   two of the three forms carry an id. */
export function parseAppliesTo(value: string) {
  if (value.startsWith("track:")) {
    return { type: "track" as const, id: value.slice(6) };
  }
  if (value.startsWith("persona:")) {
    return { type: "persona" as const, id: value.slice(8) };
  }
  if (value.startsWith("submission:")) {
    return { type: "submission" as const, id: value.slice(11) };
  }
  return { type: "all" as const, id: null };
}

export function describeAppliesTo(
  value: string,
  trackNames: Map<string, string>,
  personaNames: Map<string, string>,
) {
  const a = parseAppliesTo(value);
  if (a.type === "track") {
    return `Track: ${trackNames.get(a.id!) ?? "a deleted track"}`;
  }
  if (a.type === "persona") {
    return `Role: ${personaNames.get(a.id!) ?? "a deleted role"}`;
  }
  if (a.type === "submission") return "One submission";
  return "All accepted speakers";
}

export type AudienceMember = { participantId: string; submissionId: string };

/* Everyone a task applies to, one entry per person.
   Roles are matched by name because submission_participants stores the
   role as a string, which is also why the library rewrites those
   strings when a persona is renamed. */
export async function resolveAudience(
  db: Db,
  eventId: string,
  appliesTo: string,
  personaNames: Map<string, string>,
): Promise<AudienceMember[]> {
  const target = parseAppliesTo(appliesTo);

  const rows = await db
    .select({
      participantId: submissionParticipants.participantId,
      submissionId: submissions.id,
      refSeq: submissions.refSeq,
      trackId: submissions.trackId,
      role: submissionParticipants.role,
    })
    .from(submissions)
    .innerJoin(
      submissionParticipants,
      eq(submissionParticipants.submissionId, submissions.id),
    )
    .where(
      and(eq(submissions.eventId, eventId), eq(submissions.status, "accepted")),
    )
    .orderBy(asc(submissions.refSeq));

  const wantedRole =
    target.type === "persona" ? personaNames.get(target.id!) : null;

  const filtered = rows.filter((r) => {
    if (target.type === "track") return r.trackId === target.id;
    if (target.type === "persona") return wantedRole && r.role === wantedRole;
    if (target.type === "submission") return r.submissionId === target.id;
    return true;
  });

  // First accepted submission wins, so the row is stable across re-syncs.
  const byPerson = new Map<string, AudienceMember>();
  for (const r of filtered) {
    if (!byPerson.has(r.participantId)) {
      byPerson.set(r.participantId, {
        participantId: r.participantId,
        submissionId: r.submissionId,
      });
    }
  }
  return [...byPerson.values()];
}

export type SyncResult = { added: number; removed: number };

/* Brings a task's assignments in line with its audience.
 *
 * Adds anyone missing, which is what makes a newly created task
 * actually reach people. Removes anyone no longer in the audience only
 * when they have not started: a speaker who already uploaded their
 * slides keeps the record even if the producer narrows the task to one
 * track afterwards, because deleting evidence of work someone did is
 * never the safe default.
 */
export async function syncTaskAssignments(
  db: Db,
  eventId: string,
  taskId: string,
  appliesTo: string,
  personaNames: Map<string, string>,
): Promise<SyncResult> {
  const audience = await resolveAudience(db, eventId, appliesTo, personaNames);
  const wanted = new Map(audience.map((a) => [a.participantId, a]));

  const existing = await db
    .select({
      id: taskAssignments.id,
      participantId: taskAssignments.participantId,
      status: taskAssignments.status,
      fileUrl: taskAssignments.fileUrl,
      notes: taskAssignments.notes,
      completedAt: taskAssignments.completedAt,
    })
    .from(taskAssignments)
    .where(eq(taskAssignments.taskId, taskId));

  const have = new Set(existing.map((e) => e.participantId));

  let added = 0;
  for (const member of audience) {
    if (have.has(member.participantId)) continue;
    await db
      .insert(taskAssignments)
      .values({
        taskId,
        participantId: member.participantId,
        submissionId: member.submissionId,
        status: "not_started",
      })
      .onConflictDoNothing();
    added++;
  }

  const untouched = (a: (typeof existing)[number]) =>
    a.status === "not_started" && !a.fileUrl && !a.notes && !a.completedAt;

  const stale = existing.filter(
    (a) => !wanted.has(a.participantId) && untouched(a),
  );
  if (stale.length) {
    await db.delete(taskAssignments).where(
      inArray(
        taskAssignments.id,
        stale.map((s) => s.id),
      ),
    );
  }

  return { added, removed: stale.length };
}

/* How many speakers a delete would affect, for the confirmation. */
export async function assignmentImpact(db: Db, taskId: string) {
  const rows = await db
    .select({
      participantId: taskAssignments.participantId,
      status: taskAssignments.status,
    })
    .from(taskAssignments)
    .where(eq(taskAssignments.taskId, taskId));

  const done = rows.filter(
    (r) => r.status === "complete" || r.status === "waived",
  ).length;
  return { speakers: rows.length, done };
}

export async function nextSortOrder(db: Db, eventId: string) {
  const rows = await db
    .select({ sortOrder: tasks.sortOrder })
    .from(tasks)
    .where(eq(tasks.eventId, eventId));
  return rows.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
}

/* Names for the audience label, kept here so the route does not have to
   know how personas are stored. */
export async function participantNames(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({
      id: participants.id,
      firstName: participants.firstName,
      lastName: participants.lastName,
      email: participants.email,
    })
    .from(participants)
    .where(inArray(participants.id, ids));
  return new Map(
    rows.map((r) => [
      r.id,
      [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
    ]),
  );
}
