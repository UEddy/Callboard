import type { LoaderFunctionArgs } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  assignments,
  evaluationPlans,
  events,
  participants,
  rooms,
  scores,
  submissionParticipants,
  submissions,
  tracks,
} from "~/db/schema";
import { loadSubmissionList, statusLabel, type Kind } from "~/lib/submission-list";
import {
  byScoreDesc,
  comparatorFor,
  computeEvaluationResults,
  criteriaColumns,
  isScored,
  readSort,
} from "~/lib/evaluation";
import { buildCsv, buildXlsx, type Cell } from "~/lib/xlsx";
import {
  detectConflicts,
  durationFor,
  eventDays,
  type Scheduled,
} from "~/lib/schedule";
import { dayIsoIn, fmtDateIn, fmtTimeIn, safeZone, zoneAbbr } from "~/lib/tz";

/* ------------------------------------------------------------------ *
 * Exports.
 *
 * The whole point is "what I am looking at", so this re-runs the exact
 * query the screen ran, from the same parameters, rather than
 * approximating it with a second one that could drift. The submissions
 * family calls loadSubmissionList directly; the agenda rebuilds its own
 * view the same way the agenda route does.
 * ------------------------------------------------------------------ */

const HEADERS = [
  "Ref",
  "Title",
  "Speakers",
  "Track",
  "Format",
  "Level",
  "Status",
  "Room",
  "Scheduled",
  "Submitted",
  "Notified",
];

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function scheduledText(
  startsAt: unknown,
  zone: string,
): string {
  if (!startsAt) return "";
  const ms = new Date(startsAt as string | number | Date).getTime();
  if (!Number.isFinite(ms)) return "";
  return `${fmtDateIn(ms, zone, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })}, ${fmtTimeIn(ms, zone)} ${zoneAbbr(ms, zone)}`;
}

function dateText(value: unknown, zone: string) {
  if (!value) return "";
  const ms = new Date(value as string | number | Date).getTime();
  if (!Number.isFinite(ms)) return "";
  return fmtDateIn(ms, zone, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/* --- agenda ---------------------------------------------------------- */

async function agendaRows(
  db: ReturnType<typeof getDb>,
  url: URL,
): Promise<{ rows: Cell[][]; label: string }> {
  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  const zone = safeZone(event?.timezone);

  const base = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      level: submissions.level,
      roomId: submissions.roomId,
      roomName: rooms.name,
      startsAt: submissions.startsAt,
      endsAt: submissions.endsAt,
      trackId: submissions.trackId,
      trackName: tracks.name,
      trackColor: tracks.color,
      submittedAt: submissions.submittedAt,
      notifiedAt: submissions.notifiedAt,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(
      and(
        eq(submissions.eventId, DEMO_EVENT_ID),
        eq(submissions.status, "accepted"),
      ),
    );

  const ids = base.map((r) => r.id);
  const people = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          participantId: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
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

  const speakersBy = new Map<string, string[]>();
  const speakerObjs = new Map<string, { id: string; name: string }[]>();
  for (const p of people) {
    const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unnamed";
    (speakersBy.get(p.submissionId) ?? speakersBy.set(p.submissionId, []).get(p.submissionId)!).push(
      `${name} (${p.role})`,
    );
    (
      speakerObjs.get(p.submissionId) ??
      speakerObjs.set(p.submissionId, []).get(p.submissionId)!
    ).push({ id: p.participantId, name });
  }

  const view = url.searchParams.get("view") ?? "grid";
  const day = url.searchParams.get("day");

  let visible = base;

  /* The grid and the list are a single day at a time, so an export from
     them is that day. By track and conflicts span the whole event. */
  if ((view === "grid" || view === "list") && day) {
    visible = visible.filter(
      (r) => r.startsAt && dayIsoIn(new Date(r.startsAt).getTime(), zone) === day,
    );
  }

  if (view === "conflicts") {
    const scheduled: Scheduled[] = base
      .filter((r) => r.startsAt && r.roomId)
      .map((r) => {
        const startMs = new Date(r.startsAt!).getTime();
        return {
          id: r.id,
          ref: r.ref,
          title: r.title,
          roomId: r.roomId,
          startMs,
          endMs: r.endsAt
            ? new Date(r.endsAt).getTime()
            : startMs + durationFor(r.format) * 60_000,
          roomName: r.roomName,
          roomCapacity: null,
          trackId: r.trackId,
          trackName: r.trackName,
          trackColor: r.trackColor,
          format: r.format,
          speakers: speakerObjs.get(r.id) ?? [],
        };
      });
    const conflicts = detectConflicts(
      scheduled,
      eventDays(event?.startsAt ?? null, event?.endsAt ?? null, zone),
      zone,
    );
    const flagged = new Set(conflicts.flatMap((c) => c.submissionIds));
    visible = base.filter((r) => flagged.has(r.id));
  }

  visible.sort((a, b) => {
    const at = a.startsAt ? new Date(a.startsAt).getTime() : Infinity;
    const bt = b.startsAt ? new Date(b.startsAt).getTime() : Infinity;
    return at - bt || a.ref.localeCompare(b.ref);
  });

  const rows: Cell[][] = [
    HEADERS,
    ...visible.map((r) => [
      r.ref,
      r.title,
      (speakersBy.get(r.id) ?? []).join(", "),
      r.trackName ?? "",
      r.format ?? "",
      r.level ?? "",
      statusLabel(r.status),
      r.roomName ?? "",
      scheduledText(r.startsAt, zone),
      dateText(r.submittedAt, zone),
      dateText(r.notifiedAt, zone),
    ]),
  ];

  const label =
    view === "conflicts"
      ? "agenda-conflicts"
      : day
        ? `agenda-${day}`
        : "agenda";
  return { rows, label };
}

/* --- evaluations ------------------------------------------------------ *
 *
 * One row per review, not per submission: reviewer names, their
 * per-criterion scores and their comments only exist at that grain, and
 * a committee arguing about a decision needs to see who said what. The
 * submission's own weighted score and progress repeat on each of its
 * rows so the sheet can be sorted or pivoted without losing them.
 *
 * The order is the order the screen is in, sort parameters included, so
 * an export taken from a ranking reads like that ranking.
 * ------------------------------------------------------------------ */

async function evaluationRows(
  db: ReturnType<typeof getDb>,
  request: Request,
): Promise<{ rows: Cell[][]; label: string }> {
  const plans = await db
    .select()
    .from(evaluationPlans)
    .where(eq(evaluationPlans.eventId, DEMO_EVENT_ID));

  const allAssignments = plans.length
    ? await db
        .select()
        .from(assignments)
        .where(
          inArray(
            assignments.planId,
            plans.map((p) => p.id),
          ),
        )
    : [];

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
          status: submissions.status,
          trackName: tracks.name,
        })
        .from(submissions)
        .leftJoin(tracks, eq(submissions.trackId, tracks.id))
        .where(inArray(submissions.id, subIds))
    : [];
  const subById = new Map(subRows.map((s) => [s.id, s]));

  const reviewerIds = [...new Set(allAssignments.map((a) => a.participantId))];
  const reviewerRows = reviewerIds.length
    ? await db
        .select({
          id: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
          email: participants.email,
        })
        .from(participants)
        .where(inArray(participants.id, reviewerIds))
    : [];
  const reviewerName = new Map(
    reviewerRows.map((r) => [
      r.id,
      [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
    ]),
  );

  const { totals, reviews } = computeEvaluationResults({
    assignments: allAssignments,
    scores: allScores,
    plans,
  });
  const columns = criteriaColumns(plans);

  /* Ranked exactly as the screen ranks: rank from the score order, then
     whatever the visitor sorted by. */
  const scored = subRows.map((s) => ({
    ...s,
    average: totals.get(s.id)?.average ?? null,
    reviews: totals.get(s.id)?.reviews ?? 0,
    assigned: totals.get(s.id)?.assigned ?? 0,
    complete: totals.get(s.id)?.complete ?? 0,
  }));

  const rankById = new Map<string, number>();
  let position = 0;
  for (const r of [...scored].sort(byScoreDesc)) {
    if (r.average !== null) rankById.set(r.id, ++position);
  }

  const { sort, dir } = readSort(request);
  const ordered = [...scored].sort(comparatorFor(sort, dir));

  const header: Cell[] = [
    "Rank",
    "Ref",
    "Title",
    "Track",
    "Submission status",
    "Weighted score",
    "Reviews complete",
    "Reviews assigned",
    "Plan",
    "Reviewer",
    "Review status",
    "Round",
    "Reviewer score",
    ...columns.map((c) => `${c.name} (w${c.weight})`),
    "Comments",
  ];

  const rows: Cell[][] = [header];

  for (const sub of ordered) {
    const mine = reviews
      .filter((r) => r.submissionId === sub.id)
      .sort(
        (a, b) =>
          a.round - b.round ||
          (reviewerName.get(a.participantId) ?? "").localeCompare(
            reviewerName.get(b.participantId) ?? "",
          ),
      );

    const front: Cell[] = [
      rankById.get(sub.id) ?? "",
      sub.ref,
      sub.title,
      sub.trackName ?? "",
      statusLabel(sub.status),
      // Numbers stay numbers: a spreadsheet should be able to sort and
      // average this column without anybody retyping it.
      sub.average === null ? "" : Number(sub.average.toFixed(2)),
      sub.complete,
      sub.assigned,
    ];

    if (mine.length === 0) {
      rows.push([
        ...front,
        "",
        "",
        "Not assigned",
        "",
        "",
        ...columns.map(() => ""),
        "",
      ]);
      continue;
    }

    for (const r of mine) {
      rows.push([
        ...front,
        r.planName,
        reviewerName.get(r.participantId) ?? "",
        r.status,
        r.round,
        r.average === null ? "" : Number(r.average.toFixed(2)),
        /* A dropdown's number is its score, so the number is what a
           spreadsheet gets. A free text criterion has no number: its
           answer is the text, and it goes in its own column rather than
           being lost among the comments. */
        ...columns.map((c) => {
          if (!isScored(c)) return r.comments[c.key] ?? "";
          return c.key in r.values ? r.values[c.key] : "";
        }),
        /* Comments are per criterion, so they are labelled rather than
           run together into one anonymous paragraph. */
        columns
          .filter((c) => isScored(c) && r.comments[c.key])
          .map((c) => `${c.name}: ${r.comments[c.key]}`)
          .join(" | "),
      ]);
    }
  }

  const suffix = sort === "score" && dir === "desc" ? "" : `-by-${sort}-${dir}`;
  return { rows, label: `evaluations${suffix}` };
}

/* --- submissions family ---------------------------------------------- */

async function listRows(
  db: ReturnType<typeof getDb>,
  request: Request,
  kind: Kind,
): Promise<{ rows: Cell[][]; label: string }> {
  const data = await loadSubmissionList(db, request, kind);
  const zone = data.eventZone;

  const rows: Cell[][] = [
    HEADERS,
    ...data.rows.map((r) => [
      r.ref,
      r.title,
      (data.speakersBySubmission[r.id] ?? [])
        .map((s) => `${s.name} (${s.role})`)
        .join(", "),
      r.trackName ?? "",
      r.format ?? "",
      r.level ?? "",
      statusLabel(r.status),
      r.roomName ?? "",
      scheduledText(r.startsAt, zone),
      dateText(r.submittedAt, zone),
      dateText(r.notifiedAt, zone),
    ]),
  ];

  const base = kind ?? "submissions";
  const tab = data.tabKey === "all" ? "" : `-${data.tabKey}`;
  return { rows, label: `${base}${tab}` };
}

/* --- route ------------------------------------------------------------ */

export async function loader({ context, request }: LoaderFunctionArgs) {
  const db = getDb(context);
  const url = new URL(request.url);

  const source = url.searchParams.get("source") ?? "submissions";
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";

  const { rows, label } =
    source === "agenda"
      ? await agendaRows(db, url)
      : source === "evaluations"
        ? await evaluationRows(db, request)
        : await listRows(
            db,
            request,
            source === "abstracts" || source === "sessions" ? source : null,
          );

  const filename = `callboard-${label}-${stamp()}.${format}`;

  const body =
    format === "xlsx"
      ? await buildXlsx(rows, label.slice(0, 31))
      : buildCsv(rows);

  return new Response(body as BodyInit, {
    headers: {
      "Content-Type":
        format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(body.length),
      // An export is a snapshot of live data, never a cacheable asset.
      "Cache-Control": "no-store",
    },
  });
}
