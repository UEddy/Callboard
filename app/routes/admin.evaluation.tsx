import { Form, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  submissions,
  submissionParticipants,
  participants,
  tracks,
  evaluationPlans,
  assignments,
  scores,
  evaluatorConflicts,
} from "~/db/schema";

type Criterion = { key: string; name: string; weight: number; description?: string };

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

  const conflicts = await db
    .select()
    .from(evaluatorConflicts)
    .where(
      inArray(
        evaluatorConflicts.submissionId,
        subIds.length ? subIds : ["none"],
      ),
    );

  // Weighted average per submission, normalised to the plan's scale.
  const planById = new Map(plans.map((p) => [p.id, p]));
  const perSubmission = new Map<
    string,
    { total: number; count: number; complete: number; assigned: number }
  >();

  for (const a of allAssignments) {
    const entry = perSubmission.get(a.submissionId) ?? {
      total: 0,
      count: 0,
      complete: 0,
      assigned: 0,
    };
    entry.assigned += 1;
    if (a.status === "complete") entry.complete += 1;

    const plan = planById.get(a.planId);
    const criteria = (plan?.criteria ?? []) as Criterion[];
    const mine = allScores.filter((s) => s.assignmentId === a.id);
    if (mine.length && criteria.length) {
      let weighted = 0;
      let weightSum = 0;
      for (const c of criteria) {
        const s = mine.find((x) => x.criterionKey === c.key);
        if (!s) continue;
        weighted += s.value * c.weight;
        weightSum += c.weight;
      }
      if (weightSum > 0) {
        entry.total += weighted / weightSum;
        entry.count += 1;
      }
    }
    perSubmission.set(a.submissionId, entry);
  }

  const ranked = [...perSubmission.entries()]
    .map(([id, v]) => ({
      ...subById.get(id)!,
      average: v.count ? v.total / v.count : null,
      reviews: v.count,
      assigned: v.assigned,
      complete: v.complete,
    }))
    .filter((r) => r.id)
    .sort((a, b) => (b.average ?? -1) - (a.average ?? -1));

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
    return {
      id: e.id,
      name: [e.firstName, e.lastName].filter(Boolean).join(" "),
      email: e.email,
      company: e.company,
      assigned: mine.length,
      complete: mine.filter((a) => a.status === "complete").length,
      conflicts: conflicts.filter((c) => c.participantId === e.id).length,
    };
  });

  const totals = {
    evaluations: allAssignments.length,
    complete: allAssignments.filter((a) => a.status === "complete").length,
    plans: plans.length,
    evaluators: evaluators.length,
    unreviewed: ranked.filter((r) => r.reviews === 0).length,
  };

  return {
    plans,
    evaluators: evaluatorStats,
    asEvaluatorId,
    myQueue,
    ranked,
    totals,
    conflicts,
    ms: Date.now() - started,
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
      if (raw === null) continue;
      const value = Number(raw);
      const comment = String(fd.get(`comment_${key}`) ?? "") || null;

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

export default function Evaluation() {
  const {
    plans,
    evaluators,
    asEvaluatorId,
    myQueue,
    ranked,
    totals,
    conflicts,
    ms,
  } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const tab = params.get("tab") ?? "review";

  const setTab = (t: string) => {
    const n = new URLSearchParams(params);
    n.set("tab", t);
    setParams(n);
  };

  const pending = myQueue.filter((q) => q.status !== "complete");
  const current = pending[0];

  return (
    <div>
      <div className="border-b border-slate-200 bg-white px-6 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              Evaluation
            </h1>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Committee scoring with weighted criteria and conflict of interest
              handling.
            </p>
          </div>
          <div className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-500">
            {ms} ms
          </div>
        </div>

        <div className="mt-4 flex gap-1">
          {[
            ["review", `Review${pending.length ? ` (${pending.length})` : ""}`],
            ["results", "Results"],
            ["evaluators", "Evaluators"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={[
                "border-b-2 px-3 py-2 text-[13px]",
                tab === k
                  ? "border-indigo-600 font-medium text-indigo-700"
                  : "border-transparent text-slate-500 hover:text-slate-900",
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
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-slate-500">Reviewing as</span>
              <select
                value={asEvaluatorId}
                onChange={(e) => {
                  const n = new URLSearchParams(params);
                  n.set("as", e.target.value);
                  setParams(n);
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[13px]"
              >
                {evaluators.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.complete}/{e.assigned} done)
                  </option>
                ))}
              </select>
            </div>

            {!current ? (
              <div className="rounded-lg border border-slate-200 bg-white px-6 py-16 text-center">
                <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white">
                  ✓
                </div>
                <p className="text-[14px] font-medium">Queue is clear</p>
                <p className="mt-1 text-[13px] text-slate-500">
                  Nothing left to review for this evaluator.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                <div className="rounded-lg border border-slate-200 bg-white p-5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-slate-400">
                      {current.submission?.ref}
                    </span>
                    {current.submission?.trackName && (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-slate-500">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{
                            background: current.submission.trackColor ?? "#94a3b8",
                          }}
                        />
                        {current.submission.trackName}
                      </span>
                    )}
                    {current.anonymize && (
                      <span
                        className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
                        title="Speaker identity hidden to reduce bias"
                      >
                        blind review
                      </span>
                    )}
                  </div>
                  <h2 className="mt-1 text-[17px] font-semibold tracking-tight">
                    {current.submission?.title}
                  </h2>
                  <div className="mt-0.5 text-[12px] text-slate-500">
                    {current.submission?.format}
                  </div>
                  <div className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-slate-700">
                    {current.submission?.description?.replace(/<[^>]+>/g, "")}
                  </div>
                  <p className="mt-4 text-[12px] text-slate-400">
                    {pending.length - 1} more after this one.
                  </p>
                </div>

                <Form
                  method="post"
                  className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
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
                        <span className="text-[11px] text-slate-400">
                          weight {c.weight}
                        </span>
                      </div>
                      {c.description && (
                        <p className="text-[12px] text-slate-500">
                          {c.description}
                        </p>
                      )}
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
                            <span className="block cursor-pointer rounded-md border border-slate-300 py-1.5 text-center text-[13px] tabular-nums text-slate-600 peer-checked:border-slate-900 peer-checked:bg-slate-900 peer-checked:text-white hover:bg-slate-50 peer-checked:hover:bg-slate-900">
                              {n}
                            </span>
                          </label>
                        ))}
                      </div>
                      <input
                        name={`comment_${c.key}`}
                        defaultValue={current.existing[c.key]?.comment ?? ""}
                        placeholder="Optional note"
                        className="mt-1.5 w-full rounded-md border border-slate-300 px-2 py-1 text-[12px]"
                      />
                    </div>
                  ))}

                  <button
                    disabled={busy}
                    className="w-full rounded-md bg-slate-900 px-3 py-2 text-[13px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
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
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2.5"
                >
                  <div
                    className={[
                      "text-[22px] font-semibold tabular-nums",
                      s.alert ? "text-amber-600" : "text-slate-900",
                    ].join(" ")}
                  >
                    {s.value}
                  </div>
                  <div className="text-[12px] text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              {plans.map((p) => (
                <Form key={p.id} method="post">
                  <input type="hidden" name="intent" value="auto_assign" />
                  <input type="hidden" name="planId" value={p.id} />
                  <input type="hidden" name="reviewers" value="2" />
                  <button
                    disabled={busy}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    title="Two reviewers each, skipping anyone with a conflict of interest"
                  >
                    Auto-assign reviewers for {p.name}
                  </button>
                </Form>
              ))}
            </div>

            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {ranked.length === 0 ? (
                <p className="px-6 py-12 text-center text-[13px] text-slate-500">
                  Nothing assigned for review yet. Use auto-assign above.
                </p>
              ) : (
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] uppercase tracking-[0.06em] text-slate-500">
                      <th className="px-4 py-2 font-medium">Rank</th>
                      <th className="px-4 py-2 font-medium">Submission</th>
                      <th className="px-4 py-2 font-medium">Track</th>
                      <th className="px-4 py-2 font-medium">Score</th>
                      <th className="px-4 py-2 font-medium">Reviews</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((r, i) => (
                      <tr
                        key={r.id}
                        className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70"
                      >
                        <td className="px-4 py-2.5 tabular-nums text-slate-400">
                          {r.average !== null ? i + 1 : "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900">
                            {r.title}
                          </div>
                          <div className="font-mono text-[11px] text-slate-400">
                            {r.ref}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {r.trackName ?? "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.average === null ? (
                            <span className="text-slate-400">Not scored</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-indigo-500"
                                  style={{ width: `${(r.average / 5) * 100}%` }}
                                />
                              </div>
                              <span className="font-medium tabular-nums">
                                {r.average.toFixed(2)}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-slate-500">
                          {r.complete}/{r.assigned}
                        </td>
                        <td className="px-4 py-2.5 text-slate-500">{r.status}</td>
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
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] uppercase tracking-[0.06em] text-slate-500">
                    <th className="px-4 py-2 font-medium">Evaluator</th>
                    <th className="px-4 py-2 font-medium">Progress</th>
                    <th className="px-4 py-2 font-medium">Conflicts</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluators.map((e) => {
                    const pct = e.assigned
                      ? Math.round((e.complete / e.assigned) * 100)
                      : 0;
                    return (
                      <tr key={e.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900">{e.name}</div>
                          <div className="text-[12px] text-slate-500">
                            {e.company ?? e.email}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                              <div
                                className="h-full rounded-full bg-emerald-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-slate-500">
                              {e.complete}/{e.assigned}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 tabular-nums">
                          {e.conflicts || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="text-[13px] font-semibold">
                Conflicts of interest
              </h3>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Detected when an evaluator works at the same company as a
                submitter. Auto-assignment routes around these.
              </p>
              {conflicts.length === 0 ? (
                <p className="mt-2 text-[13px] text-slate-400">None detected.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-[13px] text-slate-700">
                  {conflicts.map((c) => (
                    <li key={`${c.participantId}-${c.submissionId}`}>
                      Blocked: same company as submitter
                      {c.autoDetected && (
                        <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                          auto
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
