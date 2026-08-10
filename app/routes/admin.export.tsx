import type { LoaderFunctionArgs } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  events,
  participants,
  rooms,
  submissionParticipants,
  submissions,
  tracks,
} from "~/db/schema";
import { loadSubmissionList, statusLabel, type Kind } from "~/lib/submission-list";
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
