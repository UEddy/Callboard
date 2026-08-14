/* ------------------------------------------------------------------ *
 * Evaluation results: the maths, the ordering, and the per-reviewer
 * detail behind them.
 *
 * Extracted so the results table and its export are the same numbers.
 * An export that recomputed a weighted average with its own copy of the
 * formula is the kind of thing nobody notices until a programme
 * committee is arguing about a ranking from a spreadsheet that no longer
 * matches the screen.
 * ------------------------------------------------------------------ */

/* What a reviewer is asked to give.
 *
 * numeric   the radio scale, the original and still the default
 * dropdown  author-defined options, each carrying the number it scores
 * text      prose, which answers a question the score cannot
 */
export const CRITERION_TYPES = [
  {
    key: "numeric",
    label: "Numeric scale",
    hint: "Radio buttons across the plan's scale. Counts towards the score.",
  },
  {
    key: "dropdown",
    label: "Dropdown",
    hint: "Your own options, each worth a number. Counts towards the score.",
  },
  {
    key: "text",
    label: "Free text",
    hint: "A box to write in. Recorded and shown, but not scored.",
  },
] as const;

export type CriterionType = (typeof CRITERION_TYPES)[number]["key"];

export type CriterionOption = { label: string; value: number };

export type Criterion = {
  key: string;
  name: string;
  weight: number;
  description?: string;
  /* Absent means numeric: every plan written before types existed is a
     plan of numeric criteria, and must keep working untouched. */
  type?: CriterionType;
  options?: CriterionOption[];
};

export function criterionType(c: Criterion): CriterionType {
  return c.type ?? "numeric";
}

/* Free text has an answer but not a number, so it is carried, shown and
   exported like everything else while staying out of the arithmetic. */
export function isScored(c: Criterion) {
  return criterionType(c) !== "text";
}

export function scoredCriteria(criteria: Criterion[]) {
  return criteria.filter(isScored);
}

/* --- The weighting, in words ----------------------------------------- *
 *
 * The same idea as the form builder's "what submitters will experience":
 * a producer setting numbers should read the effect of the numbers, not
 * the numbers. Weights are relative, so 30/30/20/20 and 3/3/2/2 are the
 * same plan, and only the resolved percentages tell you that.
 * ------------------------------------------------------------------ */
export function describeWeighting(criteria: Criterion[]): string {
  const scored = scoredCriteria(criteria).filter((c) => c.weight > 0);
  const textOnes = criteria.filter((c) => !isScored(c));
  const ignored = scoredCriteria(criteria).filter((c) => c.weight <= 0);

  if (scored.length === 0) {
    return textOnes.length
      ? "Nothing here counts towards a score: every criterion is free text, so submissions will be reviewed but not ranked."
      : "No criteria yet, so nothing can be scored.";
  }

  const total = scored.reduce((sum, c) => sum + c.weight, 0);
  const parts = scored.map((c, i) => {
    const pct = Math.round((c.weight / total) * 100);
    return i === 0
      ? `${c.name} counts for ${pct} percent`
      : `${c.name} ${pct} percent`;
  });

  const tail: string[] = [];
  if (ignored.length) {
    tail.push(
      `${listNames(ignored)} ${ignored.length === 1 ? "has" : "have"} no weight, so ${ignored.length === 1 ? "it counts" : "they count"} for nothing.`,
    );
  }
  if (textOnes.length) {
    tail.push(
      `${listNames(textOnes)} ${textOnes.length === 1 ? "is" : "are"} free text and ${textOnes.length === 1 ? "does" : "do"} not affect the score.`,
    );
  }

  return [`${parts.join(", ")}.`, ...tail].join(" ");
}

function listNames(criteria: Criterion[]) {
  const names = criteria.map((c) => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* --- Conflicts of interest ------------------------------------------- *
 *
 * Two ways a conflict gets recorded: detected by matching an evaluator's
 * company against a submitter's, or declared by the evaluator looking at
 * the thing. The reasons are a fixed list because they end up in front
 * of a programme chair defending a decision, and "other" with a note is
 * the escape hatch rather than free text for everything.
 * ------------------------------------------------------------------ */

export const CONFLICT_REASONS = [
  { key: "same_company", label: "We work at the same company" },
  { key: "personal", label: "I know a speaker personally" },
  { key: "competing", label: "I have a competing submission" },
  { key: "worked_on_it", label: "I was involved in this work" },
  { key: "other", label: "Other" },
] as const;

export type ConflictReason = (typeof CONFLICT_REASONS)[number]["key"];

export function isConflictReason(v: unknown): v is ConflictReason {
  return (
    typeof v === "string" && CONFLICT_REASONS.some((r) => r.key === v)
  );
}

/* Reads the stored value back for display. Rows seeded or written before
   this list existed still say something, rather than showing a raw key
   to somebody who has to act on it. */
export function conflictReasonLabel(reason: string, autoDetected: boolean) {
  const known = CONFLICT_REASONS.find((r) => r.key === reason);
  if (known) {
    return autoDetected && reason === "same_company"
      ? "Same company as a speaker"
      : known.label;
  }
  return reason.replace(/_/g, " ");
}

/* --- Ordering -------------------------------------------------------- */

export const RESULT_SORTS = [
  { key: "score", label: "Score" },
  { key: "title", label: "Submission" },
  { key: "reviews", label: "Reviews" },
] as const;

export type ResultSort = (typeof RESULT_SORTS)[number]["key"];
export type SortDir = "asc" | "desc";

/* Highest score first, unscored last, which is the ranking order and the
   default the table has always opened with. */
type RankRow = { average: number | null; ref: string };
export function byScoreDesc(a: RankRow, b: RankRow) {
  if (a.average === null && b.average === null) return a.ref.localeCompare(b.ref);
  if (a.average === null) return 1;
  if (b.average === null) return -1;
  return b.average - a.average || a.ref.localeCompare(b.ref);
}

export function readSort(request: Request): { sort: ResultSort; dir: SortDir } {
  const url = new URL(request.url);
  const rawSort = url.searchParams.get("sort") ?? "";
  const rawDir = url.searchParams.get("dir") ?? "";
  const sort = RESULT_SORTS.some((s) => s.key === rawSort)
    ? (rawSort as ResultSort)
    : "score";
  // Descending by default: the first question of a results table is who
  // came top, and that is what the screen used to hard-code.
  const dir: SortDir = rawDir === "asc" ? "asc" : "desc";
  return { sort, dir };
}

type SortableRow = {
  average: number | null;
  title: string;
  ref: string;
  complete: number;
  assigned: number;
};

/* Ascending always means what a reader expects it to mean: A before Z,
   fewest before most, lowest score before highest. */
export function comparatorFor(sort: ResultSort, dir: SortDir) {
  const flip = dir === "asc" ? -1 : 1;
  return (a: SortableRow, b: SortableRow) => {
    if (sort === "title") {
      // Titles are prose, so compare them the way a reader would.
      const cmp = a.title.localeCompare(b.title, "en", {
        sensitivity: "base",
      });
      return (dir === "asc" ? cmp : -cmp) || a.ref.localeCompare(b.ref);
    }

    if (sort === "reviews") {
      return (
        flip * (b.complete - a.complete || b.assigned - a.assigned) ||
        a.ref.localeCompare(b.ref)
      );
    }

    /* Score. A submission nobody has reviewed has no score, which is not
       the same as a low one, so it stays at the bottom in both
       directions rather than topping the "lowest first" view with rows
       that carry no information. */
    if (a.average === null && b.average === null) {
      return a.ref.localeCompare(b.ref);
    }
    if (a.average === null) return 1;
    if (b.average === null) return -1;
    return flip * (b.average - a.average) || a.ref.localeCompare(b.ref);
  };
}

/* --- The maths ------------------------------------------------------- */

export type ScoreRow = {
  assignmentId: string;
  criterionKey: string;
  value: number | null;
  comment: string | null;
};

/* One reviewer's weighted average for one submission, normalised by the
   weights they actually scored.
 *
 * Three things it deliberately ignores. A criterion the reviewer left
 * blank is averaged over what they did answer rather than counted as a
 * zero. A free text criterion has no number to add. And a score whose
 * criterion is no longer on the plan is skipped, because the loop is
 * over the plan's current criteria: removing one therefore stops it
 * counting without deleting what anybody recorded, which is the whole
 * reason it works that way round.
 */
export function weightedAverage(
  criteria: Criterion[],
  scoreRows: { criterionKey: string; value: number | null }[],
): number | null {
  if (!criteria.length || !scoreRows.length) return null;
  let weighted = 0;
  let weightSum = 0;
  for (const c of scoredCriteria(criteria)) {
    if (c.weight <= 0) continue;
    const s = scoreRows.find((x) => x.criterionKey === c.key);
    if (!s || s.value === null) continue;
    weighted += s.value * c.weight;
    weightSum += c.weight;
  }
  return weightSum > 0 ? weighted / weightSum : null;
}

export type ResultsInput = {
  assignments: {
    id: string;
    planId: string;
    participantId: string;
    submissionId: string;
    round: number;
    status: string;
  }[];
  scores: ScoreRow[];
  plans: { id: string; name: string; criteria: unknown }[];
};

export type SubmissionTotals = {
  /* The submission's score: the mean of its reviewers' weighted
     averages, counting only reviewers who scored something. */
  average: number | null;
  reviews: number;
  assigned: number;
  complete: number;
};

/* One row per review, which is the grain reviewer names, per-criterion
   scores and comments actually live at. The screen aggregates these; the
   export prints them. */
export type ReviewRow = {
  submissionId: string;
  assignmentId: string;
  planId: string;
  planName: string;
  participantId: string;
  round: number;
  status: string;
  average: number | null;
  /* criterion key -> what they gave it. Free text answers have no
     number and live in `comments` alone. */
  values: Record<string, number>;
  /* criterion key -> what they said about it, and the whole answer for a
     free text criterion */
  comments: Record<string, string>;
};

export function computeEvaluationResults(input: ResultsInput) {
  const planById = new Map(input.plans.map((p) => [p.id, p]));
  const criteriaOf = (planId: string) =>
    ((planById.get(planId)?.criteria ?? []) as Criterion[]) ?? [];

  const scoresByAssignment = new Map<string, ScoreRow[]>();
  for (const s of input.scores) {
    const arr = scoresByAssignment.get(s.assignmentId) ?? [];
    arr.push(s);
    scoresByAssignment.set(s.assignmentId, arr);
  }

  const totals = new Map<string, SubmissionTotals>();
  const reviews: ReviewRow[] = [];

  for (const a of input.assignments) {
    const entry =
      totals.get(a.submissionId) ??
      ({ average: null, reviews: 0, assigned: 0, complete: 0 } as SubmissionTotals);
    entry.assigned += 1;
    if (a.status === "complete") entry.complete += 1;

    const criteria = criteriaOf(a.planId);
    const mine = scoresByAssignment.get(a.id) ?? [];
    const average = weightedAverage(criteria, mine);

    if (average !== null) {
      // `average` holds the running sum until every review is in; it is
      // divided through below.
      entry.average = (entry.average ?? 0) + average;
      entry.reviews += 1;
    }
    totals.set(a.submissionId, entry);

    const values: Record<string, number> = {};
    const comments: Record<string, string> = {};
    for (const s of mine) {
      if (s.value !== null) values[s.criterionKey] = s.value;
      if (s.comment) comments[s.criterionKey] = s.comment;
    }

    reviews.push({
      submissionId: a.submissionId,
      assignmentId: a.id,
      planId: a.planId,
      planName: planById.get(a.planId)?.name ?? "",
      participantId: a.participantId,
      round: a.round,
      status: a.status,
      average,
      values,
      comments,
    });
  }

  for (const entry of totals.values()) {
    if (entry.reviews > 0 && entry.average !== null) {
      entry.average = entry.average / entry.reviews;
    } else {
      entry.average = null;
    }
  }

  return { totals, reviews };
}

/* --- Authoring a plan ------------------------------------------------ */

/* The key is what score rows reference, so it is derived from the name
   once and then never changes: renaming "Clarity" to "Is it clear" must
   not orphan everything already scored against it. */
export function criterionKey(name: string, taken: Set<string>) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "criterion";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  }
  return `${base}_${Date.now()}`;
}

/* "Strong yes = 5", one per line. The label is what a reviewer picks and
   the number is what it scores, because a dropdown that did not carry a
   value could not take part in a weighted average. A line with no
   number is given one by position, ascending, so a quick list still
   works. */
export function parseOptions(
  raw: string,
  scaleMin: number,
  scaleMax: number,
): CriterionOption[] {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line, i) => {
    const m = line.match(/^(.*?)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/);
    const label = (m ? m[1] : line).trim() || `Option ${i + 1}`;
    const spread =
      lines.length > 1
        ? scaleMin + Math.round((i * (scaleMax - scaleMin)) / (lines.length - 1))
        : scaleMax;
    const value = m ? Number(m[2]) : spread;
    // Clamped to the plan's scale, so one stray option cannot pull an
    // average outside the range every other screen renders against.
    return { label, value: Math.min(scaleMax, Math.max(scaleMin, value)) };
  });
}

export function formatOptions(options: CriterionOption[] | undefined) {
  return (options ?? []).map((o) => `${o.label} = ${o.value}`).join("\n");
}

export type CriterionInput = {
  key: string;
  name: string;
  description: string;
  weight: string;
  type: string;
  options: string;
};

/* Reads the editor's rows back into criteria, or explains what is wrong
   with them. Nothing is written until the whole plan is valid. */
export function parseCriteria(
  rows: CriterionInput[],
  scaleMin: number,
  scaleMax: number,
): { ok: true; criteria: Criterion[] } | { ok: false; error: string } {
  const taken = new Set<string>();
  const out: Criterion[] = [];

  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue; // A blank row is a row the author abandoned.

    const type: CriterionType = CRITERION_TYPES.some((t) => t.key === row.type)
      ? (row.type as CriterionType)
      : "numeric";

    const rawWeight = Number(row.weight);
    const weight =
      type === "text" ? 0 : Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;

    /* An existing key arrives on the row and is kept. A new criterion
       gets one derived from its name. */
    const key = row.key.trim() || criterionKey(name, taken);
    if (taken.has(key)) {
      return { ok: false, error: `Two criteria are both called "${name}".` };
    }
    taken.add(key);

    const criterion: Criterion = { key, name, weight, type };
    const description = row.description.trim();
    if (description) criterion.description = description;

    if (type === "dropdown") {
      const options = parseOptions(row.options, scaleMin, scaleMax);
      if (options.length < 2) {
        return {
          ok: false,
          error: `"${name}" is a dropdown, so it needs at least two options. Write one per line, like "Strong yes = 5".`,
        };
      }
      criterion.options = options;
    }

    out.push(criterion);
  }

  if (out.length === 0) {
    return { ok: false, error: "A plan needs at least one criterion." };
  }
  if (scoredCriteria(out).every((c) => c.weight <= 0) && scoredCriteria(out).length) {
    return {
      ok: false,
      error:
        "Every scored criterion has a weight of nought, so nothing could ever be ranked. Give at least one of them a weight.",
    };
  }

  return { ok: true, criteria: out };
}

/* Every criterion any plan defines, in plan order then criterion order,
   deduplicated by key. A flat export needs one stable column per
   criterion even when two plans score different things, so a submission
   reviewed under the workshop plan simply leaves the main programme's
   columns empty. */
export function criteriaColumns(
  plans: { id: string; criteria: unknown }[],
): Criterion[] {
  const out: Criterion[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    for (const c of (p.criteria ?? []) as Criterion[]) {
      if (!c?.key || seen.has(c.key)) continue;
      seen.add(c.key);
      out.push(c);
    }
  }
  return out;
}
