/* ------------------------------------------------------------------ *
 * Category routing.
 *
 * A form can carry rules like "when Format is Workshop (90 min), send it
 * to the workshop review plan". They run at submit time, from both the
 * public form and the API, so this is the single implementation both
 * call rather than two that drift.
 *
 * Everything it does is recorded on the submission as a routing trail,
 * denormalised into plain language. A producer looking at a submission
 * three weeks later needs to know why it is in this track, and the
 * answer must survive someone editing or deleting the rule afterwards.
 * ------------------------------------------------------------------ */

import { and, eq, inArray } from "drizzle-orm";
import {
  assignments,
  evaluationPlans,
  evaluatorConflicts,
  fieldDefinitions,
  participants,
  routingRules,
  scores,
  submissions,
  tags,
  tracks,
} from "~/db/schema";
import type { getDb } from "~/db/client";

type Db = ReturnType<typeof getDb>;

/* Two reviewers is what the manual auto-assign uses. Same number here so
   a routed submission and a hand-assigned one look alike. */
const REVIEWERS_PER_SUBMISSION = 2;

export type RoutingEffect = {
  ruleId: string;
  condition: string;
  setTrack?: string;
  addedTags?: string[];
  /* planId is what the next run compares against; plan is the label a
     producer reads. Both, because a plan can be renamed. */
  planId?: string;
  plan?: string;
  reviewers?: number;
  notify?: string[];
  appliedAt: string;
};

/* --- Matching ------------------------------------------------------- */

/* An unanswered field never matches, including under neq. Otherwise
   every "is not X" rule would fire on every submission that skipped the
   question, which is never what the organiser meant. */
export function matches(op: string, actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (!a) return false;

  switch (op) {
    case "eq":
      return a === e;
    case "neq":
      return a !== e;
    case "in":
      return e
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(a);
    case "contains":
      return a.includes(e);
    default:
      return false;
  }
}

/* --- Context -------------------------------------------------------- */

/* The values a rule is evaluated against. Note `track`: the form submits
   a track id, but rules are written against the track name, because that
   is what an organiser types into the rule builder. Resolve it here or
   no track rule ever matches. */
export function buildContext(
  submission: {
    title: string | null;
    description: string | null;
    format: string | null;
    level: string | null;
    trackId: string | null;
    answers: Record<string, unknown> | null;
  },
  trackNameById: Map<string, string>,
): Record<string, string> {
  const ctx: Record<string, string> = {};

  for (const [k, v] of Object.entries(submission.answers ?? {})) {
    if (v === null || v === undefined) continue;
    ctx[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }

  ctx.title = submission.title ?? "";
  ctx.description = submission.description ?? "";
  ctx.format = submission.format ?? "";
  ctx.level = submission.level ?? "";
  ctx.track = submission.trackId
    ? (trackNameById.get(submission.trackId) ?? "")
    : "";

  return ctx;
}

/* --- Reviewer selection --------------------------------------------- */

/* Picks the least loaded evaluators for this plan, skipping anyone with a
   recorded conflict of interest on this submission. Mirrors the manual
   auto-assign so routed work spreads the same way. */
async function assignReviewers(
  db: Db,
  eventId: string,
  planId: string,
  submissionId: string,
): Promise<number> {
  const evaluators = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.eventId, eventId),
        eq(participants.isEvaluator, true),
      ),
    );
  if (evaluators.length === 0) return 0;

  const existing = await db
    .select({
      participantId: assignments.participantId,
      submissionId: assignments.submissionId,
    })
    .from(assignments)
    .where(eq(assignments.planId, planId));

  const conflicts = await db
    .select({ participantId: evaluatorConflicts.participantId })
    .from(evaluatorConflicts)
    .where(eq(evaluatorConflicts.submissionId, submissionId));
  const conflicted = new Set(conflicts.map((c) => c.participantId));

  const alreadyOn = new Set(
    existing.filter((a) => a.submissionId === submissionId).map((a) => a.participantId),
  );

  const load = new Map<string, number>();
  for (const e of evaluators) load.set(e.id, 0);
  for (const a of existing) {
    load.set(a.participantId, (load.get(a.participantId) ?? 0) + 1);
  }

  const eligible = evaluators
    .filter((e) => !conflicted.has(e.id) && !alreadyOn.has(e.id))
    .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));

  const chosen = eligible.slice(0, Math.max(0, REVIEWERS_PER_SUBMISSION - alreadyOn.size));
  if (chosen.length === 0) return 0;

  for (const ev of chosen) {
    // Re-running routing on a draft edit must not stack duplicates.
    await db
      .insert(assignments)
      .values({
        planId,
        participantId: ev.id,
        submissionId,
        round: 1,
        status: "pending",
      })
      .onConflictDoNothing();
  }

  return chosen.length;
}

/* Re-routing can move a submission off a plan: a draft saved as a
   workshop and then changed to a talk should not stay in the workshop
   queue. Only assignments this routing engine created previously are
   eligible for removal, which is what the old trail tells us, so a
   producer's manual auto-assign is never undone. Anything already scored
   is left alone: a reviewer's work outranks tidiness. */
async function retireDroppedPlans(
  db: Db,
  submissionId: string,
  previous: RoutingEffect[],
  current: RoutingEffect[],
): Promise<void> {
  const before = new Set(
    previous.map((t) => t.planId).filter((p): p is string => Boolean(p)),
  );
  const after = new Set(
    current.map((t) => t.planId).filter((p): p is string => Boolean(p)),
  );
  const dropped = [...before].filter((p) => !after.has(p));
  if (dropped.length === 0) return;

  const stale = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(
      and(
        eq(assignments.submissionId, submissionId),
        inArray(assignments.planId, dropped),
      ),
    );
  if (stale.length === 0) return;

  const scored = await db
    .select({ assignmentId: scores.assignmentId })
    .from(scores)
    .where(
      inArray(
        scores.assignmentId,
        stale.map((s) => s.id),
      ),
    );
  const keep = new Set(scored.map((s) => s.assignmentId));

  const removable = stale.filter((s) => !keep.has(s.id)).map((s) => s.id);
  if (removable.length === 0) return;

  await db.delete(assignments).where(inArray(assignments.id, removable));
}

/* --- Entry point ----------------------------------------------------- */

/* Evaluates every rule on the form against the submission as it now
   stands, applies the matches, and stores the trail. Safe to call again
   on the same submission: tags union, assignments dedupe, and the trail
   is replaced rather than appended so it always describes the current
   state of the submission. */
export async function applyRoutingRules(
  db: Db,
  opts: { eventId: string; formId: string; submissionId: string },
): Promise<RoutingEffect[]> {
  const { eventId, formId, submissionId } = opts;

  const rules = await db
    .select()
    .from(routingRules)
    .where(eq(routingRules.formId, formId))
    .orderBy(routingRules.sortOrder);

  if (rules.length === 0) return [];

  const submission = await db.query.submissions.findFirst({
    where: eq(submissions.id, submissionId),
  });
  if (!submission) return [];

  const [trackList, tagList, planList, defs] = await Promise.all([
    db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, eventId)),
    db.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.eventId, eventId)),
    db
      .select({ id: evaluationPlans.id, name: evaluationPlans.name })
      .from(evaluationPlans)
      .where(eq(evaluationPlans.eventId, eventId)),
    db
      .select({ key: fieldDefinitions.key, label: fieldDefinitions.label })
      .from(fieldDefinitions)
      .where(eq(fieldDefinitions.eventId, eventId)),
  ]);

  const trackNameById = new Map(trackList.map((t) => [t.id, t.name]));
  const tagNameById = new Map(tagList.map((t) => [t.id, t.name]));
  const planNameById = new Map(planList.map((p) => [p.id, p.name]));
  const labelByKey = new Map(defs.map((d) => [d.key, d.label]));

  const ctx = buildContext(submission, trackNameById);

  const trail: RoutingEffect[] = [];
  let trackId = submission.trackId;
  const tagIds = new Set(submission.tagIds ?? []);

  for (const rule of rules) {
    const actual = ctx[rule.whenFieldKey] ?? "";
    if (!matches(rule.whenOp, actual, rule.whenValue)) continue;

    const label = labelByKey.get(rule.whenFieldKey) ?? rule.whenFieldKey;
    const verb =
      rule.whenOp === "eq"
        ? "is"
        : rule.whenOp === "neq"
          ? "is not"
          : rule.whenOp === "in"
            ? "is one of"
            : "contains";

    const effect: RoutingEffect = {
      ruleId: rule.id,
      condition: `${label} ${verb} "${rule.whenValue}"`,
      appliedAt: new Date().toISOString(),
    };

    if (rule.assignTrackId && trackNameById.has(rule.assignTrackId)) {
      trackId = rule.assignTrackId;
      effect.setTrack = trackNameById.get(rule.assignTrackId);
    }

    const ruleTags = (rule.assignTagIds ?? []).filter((id) => tagNameById.has(id));
    if (ruleTags.length) {
      const added: string[] = [];
      for (const id of ruleTags) {
        if (!tagIds.has(id)) added.push(tagNameById.get(id)!);
        tagIds.add(id);
      }
      // Report what the rule attaches, even if it was already there, so
      // the reason for the tag is visible either way.
      effect.addedTags = ruleTags.map((id) => tagNameById.get(id)!);
    }

    if (rule.assignPlanId && planNameById.has(rule.assignPlanId)) {
      effect.planId = rule.assignPlanId;
      effect.plan = planNameById.get(rule.assignPlanId);
      effect.reviewers = await assignReviewers(
        db,
        eventId,
        rule.assignPlanId,
        submissionId,
      );
    }

    // Recorded, not sent. Rule driven notifications are not wired up, and
    // pretending otherwise in the trail would be worse than saying so.
    if (rule.notifyEmails?.length) effect.notify = rule.notifyEmails;

    trail.push(effect);
  }

  await retireDroppedPlans(db, submissionId, submission.routingTrail ?? [], trail);

  await db
    .update(submissions)
    .set({
      trackId,
      tagIds: [...tagIds],
      routingTrail: trail,
      updatedAt: new Date(),
    })
    .where(eq(submissions.id, submissionId));

  return trail;
}
