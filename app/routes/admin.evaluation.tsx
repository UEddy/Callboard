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
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  submissions,
  submissionParticipants,
  participants,
  tracks,
  evaluationPlans,
  assignments,
  scores,
  evaluatorConflicts,
  emailLog,
  emailTemplates,
  events,
} from "~/db/schema";
import {
  CONFLICT_REASONS,
  CRITERION_TYPES,
  RESULT_SORTS,
  byScoreDesc,
  comparatorFor,
  computeEvaluationResults,
  conflictReasonLabel,
  createAssignments,
  describeAssignment,
  criterionType,
  describeWeighting,
  formatOptions,
  isConflictReason,
  isScored,
  parseCriteria,
  readSort,
  type Criterion,
  type ResultSort,
  type SortDir,
} from "~/lib/evaluation";
import { OptionsMenu } from "~/components/OptionsMenu";
import { render, sendEmail } from "~/lib/email";
import { mergeVars, usesMagicLink } from "~/lib/emails";
import { mintSignInLink } from "~/lib/people";
import {
  COOLDOWN_WARNING,
  agoLabel,
  describeNudge,
  recentlyNudged,
} from "~/lib/nudge";

/* Used until somebody writes a review_reminder template of their own, so
   a fresh install can chase a committee rather than quietly doing
   nothing. */
const DEFAULT_REVIEW_REMINDER = {
  subject: "{{reviewCount}} {{reviewWord}} still waiting on your review",
  bodyHtml:
    "<p>Hi {{participant.firstName}},</p>" +
    "<p>You have <strong>{{reviewCount}}</strong> {{reviewWord}} still to review for {{event.name}}.</p>" +
    '<p><a href="{{queueUrl}}">Open your review queue</a></p>' +
    "<p>Thank you for helping put the programme together.</p>",
};

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);

  const plans = await db
    .select()
    .from(evaluationPlans)
    .where(eq(evaluationPlans.eventId, DEMO_EVENT_ID));

  const evaluators = await db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.eventId, DEMO_EVENT_ID),
        eq(participants.isEvaluator, true),
      ),
    );

  const asEvaluatorId = url.searchParams.get("as") ?? evaluators[0]?.id ?? "";

  const allAssignments = await db
    .select()
    .from(assignments)
    .where(
      inArray(
        assignments.planId,
        plans.length ? plans.map((p) => p.id) : ["none"],
      ),
    );

  const allScores = allAssignments.length
    ? await db
        .select()
        .from(scores)
        .where(
          inArray(
            scores.assignmentId,
            allAssignments.map((a) => a.id),
          ),
        )
    : [];

  const subIds = [...new Set(allAssignments.map((a) => a.submissionId))];
  const subRows = subIds.length
    ? await db
        .select({
          id: submissions.id,
          ref: submissions.ref,
          title: submissions.title,
          description: submissions.description,
          status: submissions.status,
          format: submissions.format,
          trackName: tracks.name,
          trackColor: tracks.color,
        })
        .from(submissions)
        .leftJoin(tracks, eq(submissions.trackId, tracks.id))
        .where(inArray(submissions.id, subIds))
    : [];
  const subById = new Map(subRows.map((s) => [s.id, s]));

  /* Scoped to the event rather than to submissions that currently have
     an assignment: declaring a conflict takes the assignment away, and a
     conflict that disappeared from this list the moment it did its job
     would be worse than not recording it. */
  const conflicts = await db
    .select({
      participantId: evaluatorConflicts.participantId,
      submissionId: evaluatorConflicts.submissionId,
      reason: evaluatorConflicts.reason,
      autoDetected: evaluatorConflicts.autoDetected,
      ref: submissions.ref,
      title: submissions.title,
      firstName: participants.firstName,
      lastName: participants.lastName,
      email: participants.email,
    })
    .from(evaluatorConflicts)
    .innerJoin(
      submissions,
      eq(evaluatorConflicts.submissionId, submissions.id),
    )
    .innerJoin(
      participants,
      eq(evaluatorConflicts.participantId, participants.id),
    )
    .where(eq(submissions.eventId, DEMO_EVENT_ID))
    .orderBy(asc(submissions.refSeq));

  /* Weighted average per submission, normalised to the plan's scale.
     The maths lives in ~/lib/evaluation so the export prints the same
     numbers this table ranks by. */
  const planById = new Map(plans.map((p) => [p.id, p]));
  const { totals: perSubmission } = computeEvaluationResults({
    assignments: allAssignments,
    scores: allScores,
    plans,
  });

  const scored = [...perSubmission.entries()]
    .map(([id, v]) => ({
      ...subById.get(id)!,
      average: v.average,
      reviews: v.reviews,
      assigned: v.assigned,
      complete: v.complete,
    }))
    .filter((r) => r.id);

  /* Rank is a property of the score, not of where a row happens to sit
     on screen. Sorting the table by title must not renumber it, so it is
     worked out once from the score order and carried on the row. */
  const rankById = new Map<string, number>();
  let position = 0;
  for (const r of [...scored].sort(byScoreDesc)) {
    if (r.average !== null) rankById.set(r.id, ++position);
  }

  const { sort, dir } = readSort(request);
  const ranked = [...scored]
    .map((r) => ({ ...r, rank: rankById.get(r.id) ?? null }))
    .sort(comparatorFor(sort, dir));

  // The signed-in evaluator's own queue.
  const myQueue = allAssignments
    .filter((a) => a.participantId === asEvaluatorId)
    .map((a) => {
      const plan = planById.get(a.planId);
      const mine = allScores.filter((s) => s.assignmentId === a.id);
      return {
        assignmentId: a.id,
        planId: a.planId,
        planName: plan?.name ?? "",
        criteria: (plan?.criteria ?? []) as Criterion[],
        scaleMin: plan?.scaleMin ?? 1,
        scaleMax: plan?.scaleMax ?? 5,
        anonymize: plan?.anonymize ?? false,
        status: a.status,
        submission: subById.get(a.submissionId),
        existing: Object.fromEntries(
          mine.map((s) => [s.criterionKey, { value: s.value, comment: s.comment }]),
        ),
      };
    });

  const evaluatorStats = evaluators.map((e) => {
    const mine = allAssignments.filter((a) => a.participantId === e.id);
    const outstanding = mine.filter((a) => a.status !== "complete");
    /* The most recent chase across their open reviews, which is what
       "reminded 2d ago" means for a person rather than for one row. */
    const lastNudgedAt = outstanding.reduce<number | null>((latest, a) => {
      const at = a.lastNudgedAt ? new Date(a.lastNudgedAt).getTime() : null;
      return at && (!latest || at > latest) ? at : latest;
    }, null);

    return {
      id: e.id,
      name: [e.firstName, e.lastName].filter(Boolean).join(" "),
      email: e.email,
      company: e.company,
      assigned: mine.length,
      complete: mine.filter((a) => a.status === "complete").length,
      outstanding: outstanding.length,
      lastNudgedAt,
      conflicts: conflicts.filter((c) => c.participantId === e.id).length,
    };
  });

  /* Per plan: what an edit would touch, and what a delete would take
     with it. Counted here so the editor can warn before the producer
     commits rather than after. */
  const scoredAssignmentIds = new Set(allScores.map((s) => s.assignmentId));
  const planStats = plans.map((p) => {
    const mine = allAssignments.filter((a) => a.planId === p.id);
    return {
      id: p.id,
      assignments: mine.length,
      scoredReviews: mine.filter((a) => scoredAssignmentIds.has(a.id)).length,
      submissions: new Set(mine.map((a) => a.submissionId)).size,
    };
  });

  /* Candidates for the assign panel, loaded only when it is open.
     Drafts and withdrawn submissions are left out: nobody reviews a
     proposal its author has not finished or has taken back. */
  const assignFor = url.searchParams.get("assign");
  const assignCandidates = assignFor
    ? (
        await db
          .select({
            id: submissions.id,
            ref: submissions.ref,
            title: submissions.title,
            status: submissions.status,
            trackName: tracks.name,
          })
          .from(submissions)
          .leftJoin(tracks, eq(submissions.trackId, tracks.id))
          .where(
            and(
              eq(submissions.eventId, DEMO_EVENT_ID),
              notInArray(submissions.status, ["draft", "withdrawn"]),
            ),
          )
          .orderBy(asc(submissions.refSeq))
      ).map((s) => ({
        ...s,
        /* Both states are shown rather than filtered out of existence: a
           producer looking for a submission needs to see why it is not
           on offer, or they will go looking for it again tomorrow. */
        assigned: allAssignments.some(
          (a) => a.participantId === assignFor && a.submissionId === s.id,
        ),
        conflict: conflicts.some(
          (c) => c.participantId === assignFor && c.submissionId === s.id,
        ),
      }))
    : [];

  const totals = {
    evaluations: allAssignments.length,
    complete: allAssignments.filter((a) => a.status === "complete").length,
    plans: plans.length,
    evaluators: evaluators.length,
    unreviewed: ranked.filter((r) => r.reviews === 0).length,
  };

  return {
    plans,
    planStats,
    assignFor,
    assignCandidates,
    editPlanId: url.searchParams.get("plan"),
    creatingPlan: url.searchParams.get("newplan") === "1",
    evaluators: evaluatorStats,
    asEvaluatorId,
    myQueue,
    ranked,
    sort,
    dir,
    totals,
    conflicts,
    ms: Date.now() - started,
  };
}

/* What is riding on a plan: how many reviews exist against it and how
   many of those carry a score. Used to warn before an edit and before a
   delete, because the two have very different consequences and a
   producer deserves to know which one they are about to do. */
async function planImpact(db: ReturnType<typeof getDb>, planId: string) {
  const rows = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(eq(assignments.planId, planId));

  if (rows.length === 0) return { assignments: 0, scoredReviews: 0 };

  const scored = await db
    .select({ assignmentId: scores.assignmentId })
    .from(scores)
    .where(
      inArray(
        scores.assignmentId,
        rows.map((r) => r.id),
      ),
    );

  return {
    assignments: rows.length,
    scoredReviews: new Set(scored.map((s) => s.assignmentId)).size,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "score") {
    const assignmentId = String(fd.get("assignmentId"));
    const keys = (fd.getAll("criterionKey") as string[]).filter(Boolean);

    for (const key of keys) {
      const raw = fd.get(`value_${key}`);
      const comment = String(fd.get(`comment_${key}`) ?? "") || null;

      /* A free text criterion posts no value at all: its answer is the
         comment. Recording a nought for it would drag every average it
         touched towards the bottom of the scale. */
      const value =
        raw === null || String(raw).trim() === "" ? null : Number(raw);
      if (value === null && comment === null) continue;

      const existing = await db
        .select({ id: scores.id })
        .from(scores)
        .where(
          and(eq(scores.assignmentId, assignmentId), eq(scores.criterionKey, key)),
        );

      if (existing.length) {
        await db
          .update(scores)
          .set({ value, comment })
          .where(eq(scores.id, existing[0].id));
      } else {
        await db.insert(scores).values({
          assignmentId,
          criterionKey: key,
          value,
          comment,
        });
      }
    }

    await db
      .update(assignments)
      .set({ status: "complete" })
      .where(eq(assignments.id, assignmentId));

    return { ok: true };
  }

  /* --- Spread unreviewed submissions across evaluators -------------- */
  /* One reviewer, several submissions, chosen by hand. Round robin is
     for filling a programme; this is for "she should look at these two". */
  if (intent === "assign_submissions") {
    const participantId = String(fd.get("participantId") ?? "");
    const planId = String(fd.get("planId") ?? "");
    const submissionIds = (fd.getAll("submissionIds") as string[]).filter(
      Boolean,
    );

    const plan = await db.query.evaluationPlans.findFirst({
      where: and(
        eq(evaluationPlans.id, planId),
        eq(evaluationPlans.eventId, DEMO_EVENT_ID),
      ),
    });
    if (!plan) return { ok: false, error: "Pick a plan to assign under." };
    if (!submissionIds.length) {
      return { ok: false, error: "Pick at least one submission." };
    }

    const result = await createAssignments(db, {
      planId,
      pairs: submissionIds.map((submissionId) => ({
        participantId,
        submissionId,
      })),
    });

    return {
      ok: result.blockedByConflict === 0,
      assigned: `${describeAssignment(result)} Under ${plan.name}.`,
    };
  }

  /* --- Chasing reviewers -------------------------------------------- *
   *
   * The same shape as chasing speakers on the onboarding board: a real
   * email that says how much is outstanding and links to the queue, a
   * timestamp stamped only when it actually left, and a result that
   * counts what happened rather than what was attempted.
   * ------------------------------------------------------------------ */
  if (intent === "remind_reviewer" || intent === "remind_all_reviewers") {
    const env = context.get(cloudflareContext).env;
    const origin = new URL(request.url).origin;
    const now = new Date();

    const targets =
      intent === "remind_all_reviewers"
        ? (fd.getAll("allReviewerIds") as string[])
        : [String(fd.get("participantId"))];
    const ids = targets.filter(Boolean);
    if (!ids.length) return { ok: false, error: "Nobody to remind." };

    const event = await db.query.events.findFirst({
      where: eq(events.id, DEMO_EVENT_ID),
    });

    const tpl = await db.query.emailTemplates.findFirst({
      where: and(
        eq(emailTemplates.eventId, DEMO_EVENT_ID),
        eq(emailTemplates.key, "review_reminder"),
      ),
    });
    if (tpl && !tpl.enabled) {
      return {
        ok: false,
        error:
          "The review reminder template is switched off, so nothing was sent.",
      };
    }

    const people = await db
      .select({
        id: participants.id,
        email: participants.email,
        firstName: participants.firstName,
        lastName: participants.lastName,
        company: participants.company,
        jobTitle: participants.jobTitle,
      })
      .from(participants)
      .where(inArray(participants.id, ids));

    /* What each reviewer still owes. A reminder that names a number the
       reviewer can check against their own queue is the one they act
       on. */
    const outstanding = await db
      .select({
        participantId: assignments.participantId,
        id: assignments.id,
      })
      .from(assignments)
      .where(
        and(
          inArray(assignments.participantId, ids),
          inArray(assignments.status, ["pending", "skipped"]),
        ),
      );

    const openBy = new Map<string, number>();
    for (const a of outstanding) {
      openBy.set(a.participantId, (openBy.get(a.participantId) ?? 0) + 1);
    }

    let sent = 0;
    let queued = 0;
    let failed = 0;
    let skipped = 0;
    let firstError: string | null = null;

    const needsLink = usesMagicLink(
      tpl?.subject ?? DEFAULT_REVIEW_REMINDER.subject,
      tpl?.bodyHtml ?? DEFAULT_REVIEW_REMINDER.bodyHtml,
    );

    for (const person of people) {
      const open = openBy.get(person.id) ?? 0;
      if (open === 0) {
        skipped++;
        continue;
      }

      const magicLinkUrl = needsLink
        ? await mintSignInLink(db, person.id, origin)
        : "";

      const vars = {
        ...mergeVars(person, event, origin, magicLinkUrl),
        reviewCount: String(open),
        reviewWord: open === 1 ? "submission" : "submissions",
        queueUrl: `${origin}/admin/evaluation?tab=review&as=${person.id}`,
      };

      const subject = render(
        tpl?.subject ?? DEFAULT_REVIEW_REMINDER.subject,
        vars,
      );
      const html = render(
        tpl?.bodyHtml ?? DEFAULT_REVIEW_REMINDER.bodyHtml,
        vars,
      );

      const result = await sendEmail(env, { to: person.email, subject, html });

      if (!result.ok) {
        failed++;
        firstError ??= result.error ?? "send failed";
      } else if (result.simulated) queued++;
      else sent++;

      await db.insert(emailLog).values({
        eventId: DEMO_EVENT_ID,
        participantId: person.id,
        templateKey: "review_reminder",
        toEmail: person.email,
        subject,
        bodyHtml: html,
        status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
        error: result.error ?? null,
        recoveryLink: !result.ok && magicLinkUrl ? magicLinkUrl : null,
        sentAt: result.ok && !result.simulated ? new Date() : null,
      });

      // Only a chase that left the building counts as a chase.
      if (result.ok) {
        await db
          .update(assignments)
          .set({ lastNudgedAt: now })
          .where(
            and(
              eq(assignments.participantId, person.id),
              inArray(assignments.status, ["pending", "skipped"]),
            ),
          );
      }
    }

    return {
      ok: failed === 0,
      failed,
      nudged: describeNudge({ sent, queued, failed, skipped, firstError }),
    };
  }

  /* --- Plan CRUD ---------------------------------------------------- */

  if (intent === "plan_create" || intent === "plan_update") {
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { ok: false, error: "Give the plan a name." };

    const scaleMin = Math.trunc(Number(fd.get("scaleMin") ?? 1));
    const scaleMax = Math.trunc(Number(fd.get("scaleMax") ?? 5));
    if (!Number.isFinite(scaleMin) || !Number.isFinite(scaleMax)) {
      return { ok: false, error: "The scale has to be two whole numbers." };
    }
    if (scaleMax - scaleMin < 1) {
      return {
        ok: false,
        error: `A scale of ${scaleMin} to ${scaleMax} gives a reviewer nothing to choose between. The top has to be above the bottom.`,
      };
    }
    if (scaleMax - scaleMin > 20) {
      return {
        ok: false,
        error: `${scaleMin} to ${scaleMax} is ${scaleMax - scaleMin + 1} radio buttons in a row. Keep a scale to 20 points or fewer.`,
      };
    }

    /* The editor posts parallel arrays, one entry per row. */
    const rows = (fd.getAll("c_name") as string[]).map((_, i) => ({
      key: String(fd.getAll("c_key")[i] ?? ""),
      name: String(fd.getAll("c_name")[i] ?? ""),
      description: String(fd.getAll("c_description")[i] ?? ""),
      weight: String(fd.getAll("c_weight")[i] ?? ""),
      type: String(fd.getAll("c_type")[i] ?? "numeric"),
      options: String(fd.getAll("c_options")[i] ?? ""),
    }));

    const parsed = parseCriteria(rows, scaleMin, scaleMax);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const values = {
      name,
      criteria: parsed.criteria,
      scaleMin,
      scaleMax,
      anonymize: fd.get("anonymize") === "on",
    };

    if (intent === "plan_create") {
      await db.insert(evaluationPlans).values({
        eventId: DEMO_EVENT_ID,
        rounds: 1,
        ...values,
      });
      return { ok: true, planSaved: `Created "${name}".` };
    }

    const planId = String(fd.get("planId"));
    const before = await db.query.evaluationPlans.findFirst({
      where: eq(evaluationPlans.id, planId),
    });
    if (!before) return { ok: false, error: "That plan no longer exists." };

    await db
      .update(evaluationPlans)
      .set(values)
      .where(eq(evaluationPlans.id, planId));

    /* Nothing in `scores` is touched by an edit, ever. Removing a
       criterion leaves its rows where they are and they simply stop
       being counted, because the average is computed over the plan's
       current criteria. Say so, with the number, because "will this lose
       my committee's work" is the only question worth answering here. */
    const impact = await planImpact(db, planId);
    const beforeCriteria = (before.criteria ?? []) as Criterion[];
    const dropped = beforeCriteria.filter(
      (b) => !parsed.criteria.some((c) => c.key === b.key),
    );

    const notes = [`Saved "${name}".`];
    if (impact.scoredReviews > 0) {
      notes.push(
        `${impact.scoredReviews} recorded review${impact.scoredReviews === 1 ? "" : "s"} ${impact.scoredReviews === 1 ? "was" : "were"} kept and re-totalled against the new weights.`,
      );
    }
    if (dropped.length) {
      notes.push(
        `${dropped.map((d) => `"${d.name}"`).join(", ")} ${dropped.length === 1 ? "was removed. Its scores are still on record but no longer count" : "were removed. Their scores are still on record but no longer count"} towards the total.`,
      );
    }

    return { ok: true, planSaved: notes.join(" ") };
  }

  if (intent === "plan_delete") {
    const planId = String(fd.get("planId"));
    const plan = await db.query.evaluationPlans.findFirst({
      where: eq(evaluationPlans.id, planId),
    });
    if (!plan) return { ok: false, error: "That plan no longer exists." };

    const impact = await planImpact(db, planId);
    /* Deleting the plan cascades to its assignments and through them to
       the scores, so this one really does destroy work. The confirmation
       in the UI names the numbers; this repeats them in the result. */
    await db.delete(evaluationPlans).where(eq(evaluationPlans.id, planId));

    return {
      ok: true,
      planSaved:
        `Deleted "${plan.name}"` +
        (impact.assignments
          ? `, along with ${impact.assignments} assignment${impact.assignments === 1 ? "" : "s"} and ${impact.scoredReviews} recorded review${impact.scoredReviews === 1 ? "" : "s"}.`
          : ". Nothing was assigned to it."),
    };
  }

  /* An evaluator looking at a submission is the only one who can see
     most conflicts: the company match is detectable, "I mentored them"
     is not. Declaring writes the row auto-assignment already routes
     around, and takes the submission out of their queue, because asking
     somebody to keep scrolling past a thing they have just said they
     cannot judge is how it ends up scored anyway. */
  if (intent === "declare_conflict") {
    const assignmentId = String(fd.get("assignmentId") ?? "");
    const rawReason = String(fd.get("reason") ?? "");
    const reason = isConflictReason(rawReason) ? rawReason : "other";

    /* Whose conflict it is comes from the assignment, never from the
       form: a participant id in a hidden field is a way to record a
       conflict against somebody else. */
    const assignment = await db.query.assignments.findFirst({
      where: eq(assignments.id, assignmentId),
    });
    if (!assignment) return { ok: false, error: "That review is no longer assigned." };

    const submission = await db.query.submissions.findFirst({
      where: eq(submissions.id, assignment.submissionId),
    });

    await db
      .insert(evaluatorConflicts)
      .values({
        participantId: assignment.participantId,
        submissionId: assignment.submissionId,
        reason,
        autoDetected: false,
      })
      .onConflictDoNothing();

    /* Every assignment they hold on that submission, not just this one:
       the conflict is with the submission, so a second round or a second
       plan would put it straight back in front of them. Scores they had
       already left go with it, which is the point. */
    const removed = await db
      .delete(assignments)
      .where(
        and(
          eq(assignments.participantId, assignment.participantId),
          eq(assignments.submissionId, assignment.submissionId),
        ),
      )
      .returning({ id: assignments.id });

    return {
      ok: true,
      declared: `${submission?.ref ?? "That submission"} is off your queue and recorded as a conflict${
        removed.length > 1 ? `, across ${removed.length} assignments` : ""
      }. Auto-assign will not offer it to you again.`,
    };
  }

  if (intent === "auto_assign") {
    const planId = String(fd.get("planId"));
    const perSubmission = Number(fd.get("reviewers") ?? 2);

    const plan = await db.query.evaluationPlans.findFirst({
      where: eq(evaluationPlans.id, planId),
    });
    if (!plan) return { ok: false };

    const evaluators = await db
      .select({ id: participants.id, company: participants.company })
      .from(participants)
      .where(
        and(
          eq(participants.eventId, DEMO_EVENT_ID),
          eq(participants.isEvaluator, true),
        ),
      );
    if (!evaluators.length) return { ok: false, error: "No evaluators" };

    const candidates = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.eventId, DEMO_EVENT_ID),
          inArray(submissions.status, ["pending", "submitted", "accept_queue"]),
        ),
      );

    const existing = await db
      .select()
      .from(assignments)
      .where(eq(assignments.planId, planId));

    const conflicts = await db.select().from(evaluatorConflicts);

    // Round-robin, skipping anyone with a declared conflict of interest.
    let cursor = 0;
    let created = 0;

    for (const sub of candidates) {
      const already = existing.filter((a) => a.submissionId === sub.id);
      let need = perSubmission - already.length;
      let attempts = 0;

      while (need > 0 && attempts < evaluators.length * 2) {
        const ev = evaluators[cursor % evaluators.length];
        cursor++;
        attempts++;

        const hasConflict = conflicts.some(
          (c) => c.participantId === ev.id && c.submissionId === sub.id,
        );
        const alreadyOn =
          already.some((a) => a.participantId === ev.id) ||
          existing.some(
            (a) => a.submissionId === sub.id && a.participantId === ev.id,
          );

        if (hasConflict || alreadyOn) continue;

        await db.insert(assignments).values({
          planId,
          participantId: ev.id,
          submissionId: sub.id,
          round: 1,
          status: "pending",
        });
        existing.push({
          planId,
          participantId: ev.id,
          submissionId: sub.id,
        } as never);
        created++;
        need--;
      }
    }

    return { ok: true, created };
  }

  return { ok: false };
}

/* ------------------------------------------------------------------ */

/* A sortable column header. The arrow is on the active column only, and
   it points the way the rows are going: down for highest first. The
   inactive columns carry a faint arrow on hover so it is discoverable
   that they sort at all, and `aria-sort` tells a screen reader the same
   thing the arrow tells everybody else. */
function SortHeader({
  column,
  label,
  sort,
  dir,
  onSort,
}: {
  column: ResultSort;
  label: string;
  sort: ResultSort;
  dir: SortDir;
  onSort: (key: ResultSort) => void;
}) {
  const active = sort === column;
  const opening = column === "title" ? "asc" : "desc";
  const next = active ? (dir === "asc" ? "desc" : "asc") : opening;
  const nextWords =
    column === "title"
      ? next === "asc"
        ? "A to Z"
        : "Z to A"
      : next === "desc"
        ? "highest first"
        : "lowest first";

  return (
    <th
      className="px-4 py-2 font-medium"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        title={`Sort by ${label.toLowerCase()}, ${nextWords}`}
        className={[
          "group inline-flex items-center gap-1 uppercase tracking-[0.06em] transition-colors",
          active ? "text-strong" : "hover:text-strong",
        ].join(" ")}
      >
        {label}
        <span
          aria-hidden
          className={[
            "text-[9px] leading-none",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-40",
          ].join(" ")}
        >
          {active && dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

export default function Evaluation() {
  const {
    plans,
    planStats,
    assignFor,
    assignCandidates,
    editPlanId,
    creatingPlan,
    evaluators,
    asEvaluatorId,
    myQueue,
    ranked,
    sort,
    dir,
    totals,
    conflicts,
    ms,
  } = useLoaderData<typeof loader>();
  const action = useActionData<{
    declared?: string;
    planSaved?: string;
    assigned?: string;
    nudged?: string;
    failed?: number;
    error?: string;
  }>();
  const [params, setParams] = useSearchParams();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const tab = params.get("tab") ?? "review";

  const setTab = (t: string) => {
    const n = new URLSearchParams(params);
    n.set("tab", t);
    setParams(n);
  };

  /* Clicking the column you are already sorted by turns it around. A
     fresh column opens the way somebody means it: highest score first,
     most reviews first, titles from A. */
  const setSort = (key: ResultSort) => {
    const opening: SortDir = key === "title" ? "asc" : "desc";
    const n = new URLSearchParams(params);
    n.set("tab", "results");
    n.set("sort", key);
    n.set("dir", sort === key ? (dir === "asc" ? "desc" : "asc") : opening);
    setParams(n);
  };

  const pending = myQueue.filter((q) => q.status !== "complete");
  const laggingReviewers = evaluators.filter((e) => e.outstanding > 0);
  const current = pending[0];

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              Evaluation
            </h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Committee scoring with weighted criteria and conflict of interest
              handling.
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>

        <div className="mt-4 flex gap-1">
          {[
            ["review", `Review${pending.length ? ` (${pending.length})` : ""}`],
            ["results", "Results"],
            ["evaluators", "Evaluators"],
            ["plans", `Plans (${plans.length})`],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={[
                "border-b-2 px-3 py-2 text-[13px]",
                tab === k
                  ? "border-accent-solid font-medium text-accent-text"
                  : "border-transparent text-dim hover:text-strong",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 py-4">
        {tab === "review" && (
          <>
            {action?.declared && (
              <p className="cb-note cb-note-success mb-3 px-3 py-2.5 text-[13px]">
                {action.declared} It is listed under{" "}
                <button
                  type="button"
                  onClick={() => setTab("evaluators")}
                  className="underline underline-offset-2"
                >
                  Evaluators
                </button>{" "}
                for the programme chair.
              </p>
            )}
            {action?.error && (
              <p className="cb-note cb-note-danger mb-3 px-3 py-2.5 text-[13px]">
                {action.error}
              </p>
            )}

            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-dim">Reviewing as</span>
              <select
                value={asEvaluatorId}
                onChange={(e) => {
                  const n = new URLSearchParams(params);
                  n.set("as", e.target.value);
                  setParams(n);
                }}
                className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px]"
              >
                {evaluators.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.complete}/{e.assigned} done)
                  </option>
                ))}
              </select>
            </div>

            {!current ? (
              <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
                <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-success-solid text-on-solid">
                  ✓
                </div>
                <p className="text-[14px] font-medium">Queue is clear</p>
                <p className="mt-1 text-[13px] text-dim">
                  Nothing left to review for this evaluator.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                <div className="rounded-lg border border-line bg-surface p-5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-faint">
                      {current.submission?.ref}
                    </span>
                    {current.submission?.trackName && (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-dim">
                        <span
                          className="cb-dot h-2 w-2"
                          style={
                            {
                              "--cb-hue":
                                current.submission.trackColor ?? "#94a3b8",
                            } as React.CSSProperties
                          }
                        />
                        {current.submission.trackName}
                      </span>
                    )}
                    {current.anonymize && (
                      <span
                        className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-body"
                        title="Speaker identity hidden to reduce bias"
                      >
                        blind review
                      </span>
                    )}
                  </div>
                  <h2 className="mt-1 text-[17px] font-semibold tracking-tight">
                    {current.submission?.title}
                  </h2>
                  <div className="mt-0.5 text-[12px] text-dim">
                    {current.submission?.format}
                  </div>
                  <div className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-body">
                    {current.submission?.description?.replace(/<[^>]+>/g, "")}
                  </div>
                  <p className="mt-4 text-[12px] text-faint">
                    {pending.length - 1} more after this one.
                  </p>

                  {/* Behind a disclosure: it is a deliberate act, not a
                      button to hit while reaching for the scores. */}
                  <details className="mt-4 border-t border-line-soft pt-3">
                    <summary className="cursor-pointer text-[12px] text-dim hover:text-strong">
                      I have a conflict of interest with this one
                    </summary>
                    <Form method="post" className="mt-2 space-y-2">
                      <input
                        type="hidden"
                        name="intent"
                        value="declare_conflict"
                      />
                      <input
                        type="hidden"
                        name="assignmentId"
                        value={current.assignmentId}
                      />
                      <p className="text-[12px] text-dim">
                        This takes {current.submission?.ref} out of your queue
                        for good, records why, and keeps auto-assign from
                        handing it back. Anything you have already scored on
                        it is discarded.
                      </p>
                      <select
                        name="reason"
                        defaultValue="same_company"
                        aria-label="Reason for the conflict"
                        className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
                      >
                        {CONFLICT_REASONS.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={busy}
                        onClick={(e) => {
                          if (
                            !confirm(
                              `Declare a conflict on ${current.submission?.ref}?\n\nIt leaves your queue permanently and any scores you left on it are discarded. The programme chair sees that you declared it, and why.`,
                            )
                          )
                            e.preventDefault();
                        }}
                        className="cb-btn cb-btn-danger px-2.5 py-1 text-[12px]"
                      >
                        Declare a conflict
                      </button>
                    </Form>
                  </details>
                </div>

                <Form
                  method="post"
                  className="space-y-4 rounded-lg border border-line bg-surface p-5"
                >
                  <input type="hidden" name="intent" value="score" />
                  <input
                    type="hidden"
                    name="assignmentId"
                    value={current.assignmentId}
                  />
                  <div className="text-[13px] font-semibold">
                    {current.planName}
                  </div>

                  {current.criteria.map((c) => (
                    <div key={c.key}>
                      <input type="hidden" name="criterionKey" value={c.key} />
                      <div className="flex items-baseline justify-between">
                        <span className="text-[13px] font-medium">{c.name}</span>
                        <span className="text-[11px] text-faint">
                          {isScored(c) ? `weight ${c.weight}` : "not scored"}
                        </span>
                      </div>
                      {c.description && (
                        <p className="text-[12px] text-dim">
                          {c.description}
                        </p>
                      )}
                      {/* Three shapes of answer, one per criterion type.
                          Free text has no number at all, which is why the
                          score row's value is nullable. */}
                      {criterionType(c) === "numeric" && (
                        <div className="mt-1.5 flex gap-1">
                          {Array.from(
                            { length: current.scaleMax - current.scaleMin + 1 },
                            (_, i) => current.scaleMin + i,
                          ).map((n) => (
                            <label key={n} className="flex-1">
                              <input
                                type="radio"
                                name={`value_${c.key}`}
                                value={n}
                                defaultChecked={
                                  current.existing[c.key]?.value === n
                                }
                                required
                                className="peer sr-only"
                              />
                              <span className="block cursor-pointer rounded-md border border-line-strong py-1.5 text-center text-[13px] tabular-nums text-body peer-checked:border-invert peer-checked:bg-invert peer-checked:text-invert-fg hover:bg-subtle peer-checked:hover:bg-invert">
                                {n}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}

                      {criterionType(c) === "dropdown" && (
                        <select
                          name={`value_${c.key}`}
                          required
                          defaultValue={
                            current.existing[c.key]?.value !== null &&
                            current.existing[c.key]?.value !== undefined
                              ? String(current.existing[c.key]?.value)
                              : ""
                          }
                          className="mt-1.5 w-full rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[13px] text-strong"
                        >
                          <option value="" disabled>
                            Choose one
                          </option>
                          {(c.options ?? []).map((o) => (
                            <option key={o.label} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}

                      {criterionType(c) === "text" ? (
                        <textarea
                          name={`comment_${c.key}`}
                          rows={3}
                          defaultValue={current.existing[c.key]?.comment ?? ""}
                          placeholder="Your answer"
                          className="mt-1.5 w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
                        />
                      ) : (
                        <input
                          name={`comment_${c.key}`}
                          defaultValue={current.existing[c.key]?.comment ?? ""}
                          placeholder="Optional note"
                          className="mt-1.5 w-full rounded-md border border-line-strong px-2 py-1 text-[12px]"
                        />
                      )}
                    </div>
                  ))}

                  <button
                    disabled={busy}
                    className="w-full rounded-md bg-invert px-3 py-2 text-[13px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
                  >
                    {busy ? "Saving" : "Submit score and continue"}
                  </button>
                </Form>
              </div>
            )}
          </>
        )}

        {tab === "results" && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Assignments", value: totals.evaluations },
                { label: "Completed", value: totals.complete },
                { label: "Evaluators", value: totals.evaluators },
                {
                  label: "Not yet reviewed",
                  value: totals.unreviewed,
                  alert: totals.unreviewed > 0,
                },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-lg border border-line bg-surface px-3 py-2.5"
                >
                  <div
                    className={[
                      "text-[22px] font-semibold tabular-nums",
                      s.alert ? "text-warn" : "text-strong",
                    ].join(" ")}
                  >
                    {s.value}
                  </div>
                  <div className="text-[12px] text-dim">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="mb-4 flex flex-wrap items-start gap-2">
              {plans.map((p) => (
                <Form key={p.id} method="post">
                  <input type="hidden" name="intent" value="auto_assign" />
                  <input type="hidden" name="planId" value={p.id} />
                  <input type="hidden" name="reviewers" value="2" />
                  <button
                    disabled={busy}
                    className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium text-body hover:bg-subtle disabled:opacity-50"
                    title="Two reviewers each, skipping anyone with a conflict of interest"
                  >
                    Auto-assign reviewers for {p.name}
                  </button>
                </Form>
              ))}

              <div className="ml-auto">
                <OptionsMenu
                  source="evaluations"
                  /* One row per review, which is what the export writes,
                     rather than the number of submissions on screen. */
                  rowCount={totals.evaluations}
                  scopeNote={`One row per review across ${ranked.length} submission${ranked.length === 1 ? "" : "s"}, in the order on screen. Carries every criterion score, the reviewer, and their comments.`}
                />
              </div>
            </div>

            {ranked.length > 0 && (
              <div className="mb-2 flex flex-wrap items-baseline gap-2 text-[12px] text-dim">
                <span>
                  Sorted by{" "}
                  <span className="font-medium text-body">
                    {RESULT_SORTS.find((s) => s.key === sort)?.label.toLowerCase()}
                  </span>
                  ,{" "}
                  {sort === "title"
                    ? dir === "asc"
                      ? "A to Z"
                      : "Z to A"
                    : sort === "reviews"
                      ? dir === "desc"
                        ? "most reviewed first"
                        : "least reviewed first"
                      : dir === "desc"
                        ? "highest first"
                        : "lowest first"}
                  {sort === "score" && ", anything unreviewed last"}. Click a
                  column to change it.
                </span>
                {(sort !== "score" || dir !== "desc") && (
                  <button
                    type="button"
                    onClick={() => setSort("score")}
                    className="text-accent-text underline-offset-2 hover:underline"
                  >
                    Back to the ranking
                  </button>
                )}
              </div>
            )}

            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {ranked.length === 0 ? (
                <p className="px-6 py-12 text-center text-[13px] text-dim">
                  Nothing assigned for review yet. Use auto-assign above.
                </p>
              ) : (
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-subtle text-[11px] uppercase tracking-[0.06em] text-dim">
                      <th
                        className="px-4 py-2 font-medium"
                        title="Position by score, whatever this table is sorted by"
                      >
                        Rank
                      </th>
                      <SortHeader
                        column="title"
                        label="Submission"
                        sort={sort}
                        dir={dir}
                        onSort={setSort}
                      />
                      <th className="px-4 py-2 font-medium">Track</th>
                      <SortHeader
                        column="score"
                        label="Score"
                        sort={sort}
                        dir={dir}
                        onSort={setSort}
                      />
                      <SortHeader
                        column="reviews"
                        label="Reviews"
                        sort={sort}
                        dir={dir}
                        onSort={setSort}
                      />
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-line-soft last:border-0 hover:bg-subtle"
                      >
                        <td className="px-4 py-2.5 tabular-nums text-faint">
                          {r.rank ?? "-"}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-strong">
                            {r.title}
                          </div>
                          <div className="font-mono text-[11px] text-faint">
                            {r.ref}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-body">
                          {r.trackName ?? "-"}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.average === null ? (
                            <span className="text-faint">Not scored</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full bg-accent-solid"
                                  style={{ width: `${(r.average / 5) * 100}%` }}
                                />
                              </div>
                              <span className="font-medium tabular-nums">
                                {r.average.toFixed(2)}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-dim">
                          {r.complete}/{r.assigned}
                        </td>
                        <td className="px-4 py-2.5 text-dim">{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {tab === "evaluators" && (
          <div className="space-y-4">
            {action?.assigned && (
              <p className="cb-note cb-note-success px-3 py-2.5 text-[13px]">
                {action.assigned}
              </p>
            )}

            {assignFor && (
              <AssignPanel
                reviewer={evaluators.find((e) => e.id === assignFor)}
                candidates={assignCandidates}
                plans={plans}
                busy={busy}
              />
            )}

            {action?.nudged && (
              <p
                className={[
                  "cb-note px-3 py-2.5 text-[13px]",
                  action.failed ? "cb-note-warn" : "cb-note-success",
                ].join(" ")}
              >
                {action.nudged}{" "}
                <Link
                  to="/admin/emails?template=review_reminder"
                  className="underline underline-offset-2"
                >
                  Every one is in the email log.
                </Link>
              </p>
            )}

            {laggingReviewers.length > 0 && (
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="remind_all_reviewers"
                />
                {laggingReviewers.map((e) => (
                  <input
                    key={e.id}
                    type="hidden"
                    name="allReviewerIds"
                    value={e.id}
                  />
                ))}
                <button
                  disabled={busy}
                  className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
                >
                  {busy
                    ? "Sending"
                    : `Remind all ${laggingReviewers.length} with incomplete reviews`}
                </button>
              </Form>
            )}

            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-subtle text-[11px] uppercase tracking-[0.06em] text-dim">
                    <th className="px-4 py-2 font-medium">Evaluator</th>
                    <th className="px-4 py-2 font-medium">Progress</th>
                    <th className="px-4 py-2 font-medium">Conflicts</th>
                    <th className="px-4 py-2 font-medium">Work</th>
                    <th className="px-4 py-2 font-medium">Chase</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluators.map((e) => {
                    const pct = e.assigned
                      ? Math.round((e.complete / e.assigned) * 100)
                      : 0;
                    return (
                      <tr key={e.id} className="border-b border-line-soft last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-strong">{e.name}</div>
                          <div className="text-[12px] text-dim">
                            {e.company ?? e.email}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-success-solid"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-dim">
                              {e.complete}/{e.assigned}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-dim tabular-nums">
                          {e.conflicts || "-"}
                        </td>
                        <td className="px-4 py-2.5">
                          <Link
                            to={`?tab=evaluators&assign=${e.id}`}
                            className="text-[12px] text-accent-text underline-offset-2 hover:underline"
                          >
                            Assign
                          </Link>
                        </td>
                        <td className="px-4 py-2.5">
                          {e.outstanding === 0 ? (
                            <span className="text-[12px] text-faint">
                              Nothing outstanding
                            </span>
                          ) : (
                            <Form
                              method="post"
                              className="flex items-center gap-2"
                            >
                              <input
                                type="hidden"
                                name="intent"
                                value="remind_reviewer"
                              />
                              <input
                                type="hidden"
                                name="participantId"
                                value={e.id}
                              />
                              <button
                                disabled={busy}
                                className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
                                title={`Email them about ${e.outstanding} outstanding review${e.outstanding === 1 ? "" : "s"}`}
                              >
                                Remind
                              </button>
                              {e.lastNudgedAt && (
                                <span
                                  className={[
                                    "text-[12px]",
                                    recentlyNudged(e.lastNudgedAt)
                                      ? "text-warn"
                                      : "text-faint",
                                  ].join(" ")}
                                  title={
                                    recentlyNudged(e.lastNudgedAt)
                                      ? COOLDOWN_WARNING
                                      : undefined
                                  }
                                >
                                  sent {agoLabel(e.lastNudgedAt)}
                                </span>
                              )}
                            </Form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg border border-line bg-surface p-4">
              <h3 className="text-[13px] font-semibold">
                Conflicts of interest{" "}
                <span className="font-normal text-faint">
                  {conflicts.length}
                </span>
              </h3>
              <p className="mt-0.5 text-[12px] text-dim">
                Detected when an evaluator works at the same company as a
                speaker, or declared by the evaluator from their review
                queue. Auto-assignment routes around both.
              </p>
              {conflicts.length === 0 ? (
                <p className="mt-2 text-[13px] text-faint">
                  None recorded. Evaluators can declare one from the Review
                  tab.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-line-soft">
                  {conflicts.map((c) => (
                    <li
                      key={`${c.participantId}-${c.submissionId}`}
                      className="flex flex-wrap items-baseline gap-x-2 py-2 text-[13px] first:pt-0 last:pb-0"
                    >
                      <span className="font-medium text-strong">
                        {[c.firstName, c.lastName].filter(Boolean).join(" ") ||
                          c.email}
                      </span>
                      <span className="text-dim">cannot review</span>
                      <span className="font-mono text-[11px] text-faint">
                        {c.ref}
                      </span>
                      <span className="text-body">{c.title}</span>
                      <span
                        className={`cb-pill ${c.autoDetected ? "cb-pill-neutral" : "cb-pill-warn"}`}
                        title={
                          c.autoDetected
                            ? "Detected by Callboard from the company on their profile"
                            : "Declared by the evaluator from their review queue"
                        }
                      >
                        {c.autoDetected ? "auto" : "declared"}
                      </span>
                      <span className="basis-full text-[12px] text-dim">
                        {conflictReasonLabel(c.reason, c.autoDetected)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {tab === "plans" && (
          <div className="max-w-3xl space-y-4">
            {action?.planSaved && (
              <p className="cb-note cb-note-success px-3 py-2.5 text-[13px]">
                {action.planSaved}
              </p>
            )}
            {action?.error && (
              <p className="cb-note cb-note-danger px-3 py-2.5 text-[13px]">
                {action.error}
              </p>
            )}

            <div className="flex items-baseline justify-between">
              <p className="text-[13px] text-dim">
                What a reviewer is asked, how it is weighted, and whether they
                see who wrote the submission.
              </p>
              <Link
                to="?tab=plans&newplan=1"
                className="cb-btn cb-btn-primary px-2.5 py-1.5 text-[13px]"
              >
                New plan
              </Link>
            </div>

            {plans.length === 0 && !creatingPlan && (
              <p className="rounded-lg border border-dashed border-line px-6 py-12 text-center text-[13px] text-dim">
                No evaluation plans yet. Without one there is nothing to assign
                reviewers to.
              </p>
            )}

            {plans.map((p) => {
              const stats = planStats.find((s) => s.id === p.id);
              const criteria = (p.criteria ?? []) as Criterion[];
              const editing = editPlanId === p.id;

              return editing ? (
                <PlanEditor
                  key={p.id}
                  plan={p}
                  stats={stats}
                  busy={busy}
                />
              ) : (
                <div
                  key={p.id}
                  className="rounded-lg border border-line bg-surface p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-[15px] font-semibold tracking-tight">
                      {p.name}
                    </h3>
                    <div className="flex items-center gap-3 text-[12px]">
                      <span className="text-dim">
                        Scale {p.scaleMin} to {p.scaleMax}
                      </span>
                      {p.anonymize && (
                        <span
                          className="cb-pill cb-pill-neutral"
                          title="Reviewers do not see who wrote the submission"
                        >
                          blind
                        </span>
                      )}
                      <Link
                        to={`?tab=plans&plan=${p.id}`}
                        className="text-accent-text underline-offset-2 hover:underline"
                      >
                        Edit
                      </Link>
                    </div>
                  </div>

                  <ul className="mt-2 divide-y divide-line-soft">
                    {criteria.map((c) => (
                      <li
                        key={c.key}
                        className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-[13px]"
                      >
                        <span className="font-medium text-strong">{c.name}</span>
                        <span className="cb-pill cb-pill-neutral">
                          {CRITERION_TYPES.find(
                            (t) => t.key === criterionType(c),
                          )?.label ?? criterionType(c)}
                        </span>
                        {isScored(c) && (
                          <span className="text-[12px] tabular-nums text-dim">
                            weight {c.weight}
                          </span>
                        )}
                        {c.description && (
                          <span className="basis-full text-[12px] text-dim">
                            {c.description}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>

                  {/* The numbers as an English sentence, the same way the
                      form builder describes participant rules. */}
                  <p className="mt-2 border-t border-line-soft pt-2 text-[13px] text-body">
                    {describeWeighting(criteria)}
                  </p>

                  <p className="mt-1 text-[12px] text-dim">
                    {stats?.assignments
                      ? `${stats.assignments} assignment${stats.assignments === 1 ? "" : "s"} across ${stats.submissions} submission${stats.submissions === 1 ? "" : "s"}, ${stats.scoredReviews} already scored.`
                      : "Nothing assigned to it yet."}
                  </p>
                </div>
              );
            })}

            {creatingPlan && <PlanEditor busy={busy} />}
          </div>
        )}
      </div>
    </div>
  );
}

/* --- Assigning submissions to one reviewer ---------------------------- *
 *
 * Searchable because a programme has hundreds of submissions and the
 * producer already knows which two they mean. Filtering happens in the
 * browser over a list the server has already scoped, so typing is
 * instant and no keystroke goes to the database.
 * ------------------------------------------------------------------ */
function AssignPanel({
  reviewer,
  candidates,
  plans,
  busy,
}: {
  reviewer?: { id: string; name: string; assigned: number };
  candidates: {
    id: string;
    ref: string;
    title: string;
    status: string;
    trackName: string | null;
    assigned: boolean;
    conflict: boolean;
  }[];
  plans: { id: string; name: string }[];
  busy: boolean;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  if (!reviewer) return null;

  const folded = q.trim().toLowerCase();
  const shown = folded
    ? candidates.filter(
        (c) =>
          c.title.toLowerCase().includes(folded) ||
          c.ref.toLowerCase().includes(folded) ||
          (c.trackName ?? "").toLowerCase().includes(folded),
      )
    : candidates;

  const available = shown.filter((c) => !c.assigned && !c.conflict);

  return (
    <Form
      method="post"
      className="space-y-3 rounded-lg border border-accent-ring bg-surface p-4"
    >
      <input type="hidden" name="intent" value="assign_submissions" />
      <input type="hidden" name="participantId" value={reviewer.id} />

      <div className="flex items-baseline justify-between">
        <h3 className="text-[14px] font-semibold">
          Assign submissions to {reviewer.name}
          <span className="ml-1.5 font-normal text-dim">
            {reviewer.assigned} already on their plate
          </span>
        </h3>
        <Link
          to="?tab=evaluators"
          className="text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
        >
          Cancel
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-56 flex-1">
          <span className="text-[13px] font-medium">Search submissions</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Title, reference or track"
            className={planField}
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Under plan</span>
          <select name="planId" defaultValue={plans[0]?.id ?? ""} className={planField}>
            {plans.length === 0 && <option value="">No plans yet</option>}
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-line-soft p-2">
        {shown.length === 0 && (
          <p className="px-2 py-6 text-center text-[13px] text-dim">
            Nothing matches “{q}”.
          </p>
        )}
        {shown.map((c) => {
          const blocked = c.assigned || c.conflict;
          return (
            <label
              key={c.id}
              className={[
                "flex items-baseline gap-2 rounded px-2 py-1.5 text-[13px]",
                blocked ? "opacity-60" : "hover:bg-subtle",
              ].join(" ")}
            >
              <input
                type="checkbox"
                name="submissionIds"
                value={c.id}
                disabled={blocked}
                checked={picked.includes(c.id)}
                onChange={(e) =>
                  setPicked((p) =>
                    e.target.checked
                      ? [...p, c.id]
                      : p.filter((x) => x !== c.id),
                  )
                }
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-line-strong"
              />
              <span className="font-mono text-[11px] text-faint">{c.ref}</span>
              <span className="min-w-0 flex-1 text-strong">{c.title}</span>
              {c.trackName && (
                <span className="shrink-0 text-[12px] text-dim">
                  {c.trackName}
                </span>
              )}
              {/* Named, not hidden: "why can I not pick this" is the next
                  question if it simply were not there. */}
              {c.conflict && (
                <span className="cb-pill cb-pill-warn shrink-0">
                  conflict of interest
                </span>
              )}
              {c.assigned && !c.conflict && (
                <span className="cb-pill cb-pill-neutral shrink-0">
                  already assigned
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={busy || picked.length === 0 || plans.length === 0}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          {busy
            ? "Assigning"
            : `Assign ${picked.length || ""} submission${picked.length === 1 ? "" : "s"}`.trim()}
        </button>
        <span className="text-[12px] text-dim">
          {available.length} available to assign
          {shown.length !== candidates.length &&
            ` of ${shown.length} matching`}
          . Conflicts of interest cannot be assigned.
        </span>
      </div>
    </Form>
  );
}

/* --- Plan editor ------------------------------------------------------ */

type CriterionRow = Criterion & { rowId: string };

function PlanEditor({
  plan,
  stats,
  busy,
}: {
  plan?: {
    id: string;
    name: string;
    scaleMin: number;
    scaleMax: number;
    anonymize: boolean;
    criteria: unknown;
  };
  stats?: { assignments: number; scoredReviews: number; submissions: number };
  busy: boolean;
}) {
  const isEdit = Boolean(plan);
  const existing = ((plan?.criteria ?? []) as Criterion[]).map((c, i) => ({
    ...c,
    rowId: `${c.key}-${i}`,
  }));

  const [rows, setRows] = useState<CriterionRow[]>(
    existing.length
      ? existing
      : [
          {
            rowId: "new-1",
            key: "",
            name: "",
            weight: 100,
            type: "numeric",
            description: "",
          },
        ],
  );
  const [scaleMin, setScaleMin] = useState(plan?.scaleMin ?? 1);
  const [scaleMax, setScaleMax] = useState(plan?.scaleMax ?? 5);

  const patch = (rowId: string, next: Partial<CriterionRow>) =>
    setRows((rs) => rs.map((r) => (r.rowId === rowId ? { ...r, ...next } : r)));

  const scoredCount = stats?.scoredReviews ?? 0;

  return (
    <Form
      method="post"
      className="space-y-4 rounded-lg border border-accent-ring bg-surface p-4"
    >
      <input
        type="hidden"
        name="intent"
        value={isEdit ? "plan_update" : "plan_create"}
      />
      {plan && <input type="hidden" name="planId" value={plan.id} />}

      <div className="flex items-baseline justify-between">
        <h3 className="text-[14px] font-semibold">
          {isEdit ? `Edit ${plan!.name}` : "New evaluation plan"}
        </h3>
        <Link
          to="?tab=plans"
          className="text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
        >
          Cancel
        </Link>
      </div>

      {/* The warning that matters: what is already scored against this
          plan, and what an edit will and will not do to it. */}
      {isEdit && scoredCount > 0 && (
        <p className="cb-note cb-note-warn px-3 py-2.5 text-[13px]">
          {scoredCount} review{scoredCount === 1 ? " has" : "s have"} already
          been scored against this plan. Nothing you do here deletes them.
          Changing a weight re-totals every affected submission, and removing a
          criterion keeps the scores on record while leaving them out of the
          total. Changing the scale does not rescale scores already given.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <label className="block">
          <span className="text-[13px] font-medium">Plan name</span>
          <input
            name="name"
            defaultValue={plan?.name ?? ""}
            placeholder="Main Program Review"
            className={planField}
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Scale from</span>
          <input
            name="scaleMin"
            type="number"
            value={scaleMin}
            onChange={(e) => setScaleMin(Number(e.target.value))}
            className={`${planField} w-24`}
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">to</span>
          <input
            name="scaleMax"
            type="number"
            value={scaleMax}
            onChange={(e) => setScaleMax(Number(e.target.value))}
            className={`${planField} w-24`}
          />
        </label>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          name="anonymize"
          defaultChecked={plan?.anonymize ?? false}
          className="mt-0.5 h-4 w-4 rounded border-line-strong"
        />
        <span className="text-[13px]">
          Blind review
          <span className="block text-[12px] text-dim">
            Reviewers see the proposal marked "blind review" and the submission
            page hides who reviewed it from everybody else.
          </span>
        </span>
      </label>

      <fieldset className="space-y-3 rounded-md border border-line-soft p-3">
        <legend className="px-1 text-[12px] font-medium text-dim">
          Criteria
        </legend>

        {rows.map((row, i) => (
          <div
            key={row.rowId}
            className="space-y-2 rounded-md border border-line-soft bg-subtle p-2.5"
          >
            <input type="hidden" name="c_key" value={row.key} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-40 flex-1">
                <span className="text-[12px] text-dim">Name</span>
                <input
                  name="c_name"
                  value={row.name}
                  onChange={(e) => patch(row.rowId, { name: e.target.value })}
                  placeholder="Relevance"
                  className={planField}
                />
              </label>
              <label>
                <span className="text-[12px] text-dim">Type</span>
                <select
                  name="c_type"
                  value={criterionType(row)}
                  onChange={(e) =>
                    patch(row.rowId, {
                      type: e.target.value as Criterion["type"],
                    })
                  }
                  className={planField}
                >
                  {CRITERION_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="text-[12px] text-dim">Weight</span>
                <input
                  name="c_weight"
                  type="number"
                  min={0}
                  value={criterionType(row) === "text" ? 0 : row.weight}
                  disabled={criterionType(row) === "text"}
                  onChange={(e) =>
                    patch(row.rowId, { weight: Number(e.target.value) })
                  }
                  className={`${planField} w-24`}
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setRows((rs) => rs.filter((r) => r.rowId !== row.rowId))
                }
                disabled={rows.length === 1}
                title={
                  row.key
                    ? "Removes it from the plan. Scores already given against it stay on record and stop counting."
                    : "Remove this row"
                }
                className="cb-btn cb-btn-danger px-2 py-1.5 text-[12px]"
              >
                Remove
              </button>
            </div>

            <label className="block">
              <span className="text-[12px] text-dim">
                Description, shown to the reviewer
              </span>
              <input
                name="c_description"
                value={row.description ?? ""}
                onChange={(e) =>
                  patch(row.rowId, { description: e.target.value })
                }
                placeholder="Does this matter to engineers shipping today?"
                className={planField}
              />
            </label>

            {criterionType(row) === "dropdown" ? (
              <label className="block">
                <span className="text-[12px] text-dim">
                  Options, one per line, as "Label = score"
                </span>
                <textarea
                  name="c_options"
                  rows={3}
                  defaultValue={formatOptions(row.options)}
                  placeholder={`Strong yes = ${scaleMax}\nMaybe = ${Math.round((scaleMin + scaleMax) / 2)}\nNo = ${scaleMin}`}
                  className={`${planField} font-mono text-[12px]`}
                />
              </label>
            ) : (
              <input type="hidden" name="c_options" value="" />
            )}

            <p className="text-[12px] text-faint">
              {CRITERION_TYPES.find((t) => t.key === criterionType(row))?.hint}
            </p>
          </div>
        ))}

        <button
          type="button"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              {
                rowId: `new-${Date.now()}`,
                key: "",
                name: "",
                weight: 10,
                type: "numeric",
                description: "",
              },
            ])
          }
          className="cb-btn cb-btn-secondary px-2.5 py-1 text-[12px]"
        >
          Add criterion
        </button>
      </fieldset>

      {/* Live, from the rows as they stand, so the effect of a weight is
          visible while it is being typed. */}
      <p className="rounded-md border border-line bg-subtle px-3 py-2 text-[13px] text-body">
        <span className="font-medium text-strong">
          How this scores:{" "}
        </span>
        {describeWeighting(rows.filter((r) => r.name.trim()))}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          {busy ? "Saving" : isEdit ? "Save plan" : "Create plan"}
        </button>

        {isEdit && (
          <button
            name="intent"
            value="plan_delete"
            disabled={busy}
            onClick={(e) => {
              const msg = stats?.assignments
                ? `Delete "${plan!.name}"?\n\nIt has ${stats.assignments} assignment${stats.assignments === 1 ? "" : "s"}, ${stats.scoredReviews} of them already scored. Deleting the plan deletes those assignments and every score recorded against them. This one cannot be undone.\n\nDelete anyway?`
                : `Delete "${plan!.name}"? Nothing is assigned to it.`;
              if (!confirm(msg)) e.preventDefault();
            }}
            className="cb-btn cb-btn-danger ml-auto px-2.5 py-1.5 text-[13px]"
          >
            Delete plan
          </button>
        )}
      </div>
    </Form>
  );
}

const planField =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong disabled:opacity-50";
