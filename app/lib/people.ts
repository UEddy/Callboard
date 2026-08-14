/* ------------------------------------------------------------------ *
 * The participant roster.
 *
 * A person is the one record that every other screen points at: a
 * submission has speakers, a task is assigned to somebody, an evaluator
 * scores things, and an email goes to an address. This module is the
 * only place that assembles all of that per person, so the roster, the
 * person page and the email composer all agree about who exists and
 * what they are involved in.
 * ------------------------------------------------------------------ */

import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { DEMO_EVENT_ID } from "~/db/client";
import {
  authTokens,
  participants,
  submissionParticipants,
  submissions,
  taskAssignments,
  tasks,
} from "~/db/schema";
import type { getDb } from "~/db/client";

type Db = ReturnType<typeof getDb>;

/* Long enough that a producer can paste it into a message and have it
   still work when the speaker reads their mail tomorrow morning, which
   is the whole point of handing one over by hand. Single use, and
   scoped to one participant, exactly like the emailed one. */
export const SIGN_IN_LINK_TTL_HOURS = 72;

/* The involvement filter. Each one answers a question a producer
   actually asks the roster: who is speaking, who got in, who is
   reviewing, and who is on the list but has done nothing yet. */
export const INVOLVEMENT = [
  { key: "all", label: "Everyone" },
  { key: "submissions", label: "Has submissions" },
  { key: "accepted", label: "Accepted" },
  { key: "evaluator", label: "Is evaluator" },
  { key: "none", label: "No submissions" },
] as const;

export type InvolvementKey = (typeof INVOLVEMENT)[number]["key"];

export function fullName(p: {
  firstName?: string | null;
  lastName?: string | null;
}) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
}

export function displayName(p: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  return fullName(p) || p.email || "Unnamed";
}

export type RosterRow = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  jobTitle: string | null;
  headshotUrl: string | null;
  isEvaluator: boolean;
  isAdmin: boolean;
  roles: string[];
  submissionCount: number;
  acceptedCount: number;
  tasksDone: number;
  tasksTotal: number;
};

function matchesInvolvement(r: RosterRow, key: InvolvementKey) {
  switch (key) {
    case "submissions":
      return r.submissionCount > 0;
    case "accepted":
      return r.acceptedCount > 0;
    case "evaluator":
      return r.isEvaluator;
    case "none":
      return r.submissionCount === 0;
    default:
      return true;
  }
}

export async function loadRoster(db: Db, request: Request) {
  const started = Date.now();
  const url = new URL(request.url);

  const q = (url.searchParams.get("q") ?? "").trim();
  const rawInvolvement = url.searchParams.get("involvement") ?? "all";
  const involvement: InvolvementKey = INVOLVEMENT.some(
    (i) => i.key === rawInvolvement,
  )
    ? (rawInvolvement as InvolvementKey)
    : "all";

  /* Name or email, and the concatenation too, so typing "ada lovelace"
     finds the person whose name is split across two columns. */
  const term = `%${q}%`;
  const search = q
    ? or(
        like(participants.email, term),
        like(participants.firstName, term),
        like(participants.lastName, term),
        like(
          sql`coalesce(${participants.firstName}, '') || ' ' || coalesce(${participants.lastName}, '')`,
          term,
        ),
        like(participants.company, term),
      )
    : undefined;

  const people = await db
    .select({
      id: participants.id,
      email: participants.email,
      firstName: participants.firstName,
      lastName: participants.lastName,
      company: participants.company,
      jobTitle: participants.jobTitle,
      headshotUrl: participants.headshotUrl,
      isEvaluator: participants.isEvaluator,
      isAdmin: participants.isAdmin,
    })
    .from(participants)
    .where(and(eq(participants.eventId, DEMO_EVENT_ID), search));

  const ids = people.map((p) => p.id);

  /* Two follow-up queries rather than a join per row: the roster is
     read constantly and D1 charges by the round trip. */
  const involvementRows = ids.length
    ? await db
        .select({
          participantId: submissionParticipants.participantId,
          role: submissionParticipants.role,
          status: submissions.status,
        })
        .from(submissionParticipants)
        .innerJoin(
          submissions,
          eq(submissionParticipants.submissionId, submissions.id),
        )
        .where(
          and(
            inArray(submissionParticipants.participantId, ids),
            eq(submissions.eventId, DEMO_EVENT_ID),
          ),
        )
    : [];

  const taskRows = ids.length
    ? await db
        .select({
          participantId: taskAssignments.participantId,
          status: taskAssignments.status,
        })
        .from(taskAssignments)
        .innerJoin(tasks, eq(taskAssignments.taskId, tasks.id))
        .where(
          and(
            inArray(taskAssignments.participantId, ids),
            eq(tasks.eventId, DEMO_EVENT_ID),
          ),
        )
    : [];

  const rows: RosterRow[] = people.map((p) => ({
    id: p.id,
    name: displayName(p),
    email: p.email,
    company: p.company,
    jobTitle: p.jobTitle,
    headshotUrl: p.headshotUrl,
    isEvaluator: p.isEvaluator,
    isAdmin: p.isAdmin,
    roles: [],
    submissionCount: 0,
    acceptedCount: 0,
    tasksDone: 0,
    tasksTotal: 0,
  }));

  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const i of involvementRows) {
    const row = byId.get(i.participantId);
    if (!row) continue;
    row.submissionCount++;
    if (i.status === "accepted") row.acceptedCount++;
    if (!row.roles.includes(i.role)) row.roles.push(i.role);
  }

  for (const t of taskRows) {
    const row = byId.get(t.participantId);
    if (!row) continue;
    row.tasksTotal++;
    if (t.status === "complete" || t.status === "waived") row.tasksDone++;
  }

  /* Counts are taken over the searched set rather than the whole event,
     so the filter chips describe the list you are looking at. */
  const counts = Object.fromEntries(
    INVOLVEMENT.map((i) => [
      i.key,
      rows.filter((r) => matchesInvolvement(r, i.key)).length,
    ]),
  ) as Record<InvolvementKey, number>;

  const filtered = rows
    .filter((r) => matchesInvolvement(r, involvement))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    rows: filtered,
    counts,
    total: rows.length,
    q,
    involvement,
    ms: Date.now() - started,
  };
}

/* The recipient picker on the email composer. Grouped by what somebody
   is to the event, because "everyone accepted" and "the review
   committee" are how a producer thinks about who to write to, and a
   flat alphabetical list of 200 addresses is not. */
export async function loadRecipientOptions(db: Db) {
  const people = await db
    .select({
      id: participants.id,
      email: participants.email,
      firstName: participants.firstName,
      lastName: participants.lastName,
      company: participants.company,
      isEvaluator: participants.isEvaluator,
    })
    .from(participants)
    .where(eq(participants.eventId, DEMO_EVENT_ID));

  const involvement = await db
    .select({
      participantId: submissionParticipants.participantId,
      status: submissions.status,
    })
    .from(submissionParticipants)
    .innerJoin(submissions, eq(submissionParticipants.submissionId, submissions.id))
    .where(eq(submissions.eventId, DEMO_EVENT_ID));

  const accepted = new Set<string>();
  const submitters = new Set<string>();
  for (const i of involvement) {
    submitters.add(i.participantId);
    if (i.status === "accepted") accepted.add(i.participantId);
  }

  return people
    .map((p) => ({
      id: p.id,
      email: p.email,
      name: displayName(p),
      company: p.company,
      group: accepted.has(p.id)
        ? "Accepted speakers"
        : p.isEvaluator
          ? "Evaluators"
          : submitters.has(p.id)
            ? "Submitted, not yet accepted"
            : "Everyone else",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const RECIPIENT_GROUPS = [
  "Accepted speakers",
  "Submitted, not yet accepted",
  "Evaluators",
  "Everyone else",
] as const;

/* Mints a one-shot sign-in link a producer can hand to somebody who
   cannot find the email. Same token table and same burn-on-use rule as
   the emailed link, so nothing here is a second, weaker way in. */
export async function mintSignInLink(
  db: Db,
  participantId: string,
  origin: string,
) {
  const token = crypto.randomUUID().replace(/-/g, "");
  await db.insert(authTokens).values({
    participantId,
    token,
    expiresAt: new Date(Date.now() + SIGN_IN_LINK_TTL_HOURS * 60 * 60_000),
  });
  return `${origin}/portal?token=${token}`;
}

/* Shared by the roster's create form and the person page's edit form so
   the two cannot disagree about what a valid person is. */
export function readPersonForm(fd: FormData) {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const firstName = String(fd.get("firstName") ?? "").trim();
  const lastName = String(fd.get("lastName") ?? "").trim();

  if (!email) return { ok: false as const, error: "An email address is required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false as const, error: `"${email}" is not an email address.` };
  }

  const links = {
    linkedin: String(fd.get("linkedin") ?? "").trim(),
    twitter: String(fd.get("twitter") ?? "").trim(),
    website: String(fd.get("website") ?? "").trim(),
  };

  return {
    ok: true as const,
    email,
    values: {
      email,
      firstName: firstName || null,
      lastName: lastName || null,
      company: String(fd.get("company") ?? "").trim() || null,
      jobTitle: String(fd.get("jobTitle") ?? "").trim() || null,
      phone: String(fd.get("phone") ?? "").trim() || null,
      pronouns: String(fd.get("pronouns") ?? "").trim() || null,
      bio: String(fd.get("bio") ?? "").trim() || null,
      isEvaluator: fd.get("isEvaluator") === "on",
      links: Object.values(links).some(Boolean) ? links : null,
      updatedAt: new Date(),
    },
  };
}

/* The unique index on (event, email) is what stops two rows for one
   person, so a clash is an ordinary outcome to explain rather than a
   500 to leak. */
export async function emailTaken(db: Db, email: string, exceptId?: string) {
  const existing = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(eq(participants.eventId, DEMO_EVENT_ID), eq(participants.email, email)),
    );
  return existing.some((r) => r.id !== exceptId);
}
