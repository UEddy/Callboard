import { useState } from "react";
import { Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  submissions,
  submissionParticipants,
  participants,
  rooms,
  tracks,
  events,
} from "~/db/schema";

/* ------------------------------------------------------------------ *
 * The event runs in America/Los_Angeles, which is PDT (UTC-7) across
 * all three days in October 2026. A fixed offset keeps the grid honest
 * without pulling in a timezone library.
 * ------------------------------------------------------------------ */
const EVENT_UTC_OFFSET = -7;
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 18;
const SLOT_MINUTES = 30;

const DURATION_BY_FORMAT: Record<string, number> = {
  Keynote: 45,
  "Talk (25 min)": 25,
  "Workshop (90 min)": 90,
  "Lightning Talk (10 min)": 10,
};

function durationFor(format: string | null) {
  return (format && DURATION_BY_FORMAT[format]) || 30;
}

function slotToUtcMs(dayIso: string, hour: number, minute: number) {
  const [y, m, d] = dayIso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - EVENT_UTC_OFFSET, minute);
}

function utcMsToLocalParts(ms: number) {
  const shifted = new Date(ms + EVENT_UTC_OFFSET * 3_600_000);
  return {
    dayIso: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function fmtTime(hour: number, minute: number) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const ap = hour < 12 ? "AM" : "PM";
  return `${h}:${String(minute).padStart(2, "0")} ${ap}`;
}

/* --- Conflict detection ------------------------------------------- */

type Scheduled = {
  id: string;
  ref: string;
  title: string;
  roomId: string | null;
  startMs: number;
  endMs: number;
  roomName: string | null;
  roomCapacity: number | null;
  trackId: string | null;
  trackName: string | null;
  trackColor: string | null;
  format: string | null;
  speakers: { id: string; name: string }[];
};

type Conflict = {
  kind: "room" | "speaker" | "hours" | "track";
  message: string;
  submissionIds: string[];
};

function detectConflicts(list: Scheduled[], dayIsos: string[]): Conflict[] {
  const out: Conflict[] = [];
  const overlaps = (a: Scheduled, b: Scheduled) =>
    a.startMs < b.endMs && b.startMs < a.endMs;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!overlaps(a, b)) continue;

      if (a.roomId && a.roomId === b.roomId) {
        out.push({
          kind: "room",
          message: `${a.roomName} is double booked: ${a.ref} and ${b.ref} overlap.`,
          submissionIds: [a.id, b.id],
        });
      }

      const shared = a.speakers.filter((s) =>
        b.speakers.some((t) => t.id === s.id),
      );
      for (const s of shared) {
        out.push({
          kind: "speaker",
          message: `${s.name} is scheduled in two places at once: ${a.ref} and ${b.ref}.`,
          submissionIds: [a.id, b.id],
        });
      }

      if (a.trackId && a.trackId === b.trackId && a.roomId !== b.roomId) {
        out.push({
          kind: "track",
          message: `Two ${a.trackName} sessions run at the same time: ${a.ref} and ${b.ref}. Attendees have to choose.`,
          submissionIds: [a.id, b.id],
        });
      }
    }
  }

  for (const s of list) {
    const start = utcMsToLocalParts(s.startMs);
    const end = utcMsToLocalParts(s.endMs);
    const outsideDay = !dayIsos.includes(start.dayIso);
    const tooEarly = start.hour < DAY_START_HOUR;
    const tooLate = end.hour > DAY_END_HOUR || (end.hour === DAY_END_HOUR && end.minute > 0);
    if (outsideDay || tooEarly || tooLate) {
      out.push({
        kind: "hours",
        message: `${s.ref} falls outside event hours.`,
        submissionIds: [s.id],
      });
    }
  }

  return out;
}

/* --- Loader -------------------------------------------------------- */

export async function loader({ context }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  const roomList = await db
    .select()
    .from(rooms)
    .where(eq(rooms.eventId, DEMO_EVENT_ID))
    .orderBy(rooms.sortOrder);

  const rows = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      format: submissions.format,
      roomId: submissions.roomId,
      startsAt: submissions.startsAt,
      endsAt: submissions.endsAt,
      trackId: submissions.trackId,
      trackName: tracks.name,
      trackColor: tracks.color,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .where(
      and(
        eq(submissions.eventId, DEMO_EVENT_ID),
        eq(submissions.status, "accepted"),
      ),
    );

  const ids = rows.map((r) => r.id);
  const speakerRows = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          participantId: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
    : [];

  const speakersBy = new Map<string, { id: string; name: string }[]>();
  for (const s of speakerRows) {
    const arr = speakersBy.get(s.submissionId) ?? [];
    arr.push({
      id: s.participantId,
      name: [s.firstName, s.lastName].filter(Boolean).join(" "),
    });
    speakersBy.set(s.submissionId, arr);
  }

  const roomById = new Map(roomList.map((r) => [r.id, r]));

  const scheduled: Scheduled[] = [];
  const unscheduled: {
    id: string;
    ref: string;
    title: string;
    format: string | null;
    trackName: string | null;
    trackColor: string | null;
    speakers: { id: string; name: string }[];
  }[] = [];

  for (const r of rows) {
    const speakers = speakersBy.get(r.id) ?? [];
    if (r.startsAt && r.roomId) {
      const startMs = new Date(r.startsAt).getTime();
      const endMs = r.endsAt
        ? new Date(r.endsAt).getTime()
        : startMs + durationFor(r.format) * 60_000;
      const room = roomById.get(r.roomId);
      scheduled.push({
        id: r.id,
        ref: r.ref,
        title: r.title,
        roomId: r.roomId,
        startMs,
        endMs,
        roomName: room?.name ?? null,
        roomCapacity: room?.capacity ?? null,
        trackId: r.trackId,
        trackName: r.trackName,
        trackColor: r.trackColor,
        format: r.format,
        speakers,
      });
    } else {
      unscheduled.push({
        id: r.id,
        ref: r.ref,
        title: r.title,
        format: r.format,
        trackName: r.trackName,
        trackColor: r.trackColor,
        speakers,
      });
    }
  }

  const dayIsos: string[] = [];
  if (event?.startsAt && event?.endsAt) {
    const start = new Date(event.startsAt);
    const end = new Date(event.endsAt);
    for (
      let d = new Date(start);
      d.getTime() <= end.getTime();
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      dayIsos.push(d.toISOString().slice(0, 10));
    }
  }

  const conflicts = detectConflicts(scheduled, dayIsos);

  return {
    event,
    roomList,
    scheduled,
    unscheduled,
    dayIsos,
    conflicts,
    ms: Date.now() - started,
  };
}

/* --- Action -------------------------------------------------------- */

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));
  const id = String(fd.get("submissionId"));

  if (intent === "unschedule") {
    await db
      .update(submissions)
      .set({ roomId: null, startsAt: null, endsAt: null, updatedAt: new Date() })
      .where(eq(submissions.id, id));
    return { ok: true };
  }

  if (intent === "place") {
    const roomId = String(fd.get("roomId"));
    const dayIso = String(fd.get("dayIso"));
    const hour = Number(fd.get("hour"));
    const minute = Number(fd.get("minute"));
    const format = String(fd.get("format") ?? "");

    const startMs = slotToUtcMs(dayIso, hour, minute);
    const endMs = startMs + durationFor(format || null) * 60_000;

    await db
      .update(submissions)
      .set({
        roomId,
        startsAt: new Date(startMs),
        endsAt: new Date(endMs),
        isDraftSchedule: false,
        updatedAt: new Date(),
      })
      .where(eq(submissions.id, id));
    return { ok: true };
  }

  return { ok: false };
}

/* --- UI ------------------------------------------------------------ */

export default function Agenda() {
  const { event, roomList, scheduled, unscheduled, dayIsos, conflicts, ms } =
    useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher();

  const view = params.get("view") ?? "grid";
  const day = params.get("day") ?? dayIsos[0] ?? "";
  const [picked, setPicked] = useState<string | null>(null);

  const conflictIds = new Set(conflicts.flatMap((c) => c.submissionIds));

  const slots: { hour: number; minute: number }[] = [];
  for (let h = DAY_START_HOUR; h < DAY_END_HOUR; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) slots.push({ hour: h, minute: m });
  }

  const onDay = scheduled.filter(
    (s) => utcMsToLocalParts(s.startMs).dayIso === day,
  );

  const place = (
    submissionId: string,
    format: string | null,
    roomId: string,
    hour: number,
    minute: number,
  ) => {
    fetcher.submit(
      {
        intent: "place",
        submissionId,
        roomId,
        dayIso: day,
        hour: String(hour),
        minute: String(minute),
        format: format ?? "",
      },
      { method: "post" },
    );
    setPicked(null);
  };

  const setView = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("view", v);
    setParams(next);
  };

  const setDay = (d: string) => {
    const next = new URLSearchParams(params);
    next.set("day", d);
    setParams(next);
  };

  return (
    <div>
      <div className="border-b border-slate-200 bg-white px-6 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Agenda</h1>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Drag a session onto a slot, or click it then click where it goes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {conflicts.length > 0 && (
              <span className="rounded-md bg-rose-50 px-2 py-1 text-[12px] font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20">
                {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}
              </span>
            )}
            <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-500">
              {ms} ms
            </span>
          </div>
        </div>

        <div className="mt-4 flex gap-1">
          {[
            ["grid", "Rooms"],
            ["list", "List"],
            ["track", "By track"],
            ["conflicts", `Conflicts${conflicts.length ? ` (${conflicts.length})` : ""}`],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={[
                "border-b-2 px-3 py-2 text-[13px]",
                view === k
                  ? "border-indigo-600 font-medium text-indigo-700"
                  : "border-transparent text-slate-500 hover:text-slate-900",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {(view === "grid" || view === "list") && dayIsos.length > 0 && (
        <div className="flex gap-2 border-b border-slate-200 bg-white px-6 py-2">
          {dayIsos.map((d, i) => (
            <button
              key={d}
              onClick={() => setDay(d)}
              className={[
                "rounded-md px-2.5 py-1 text-[13px]",
                d === day
                  ? "bg-slate-900 font-medium text-white"
                  : "text-slate-600 hover:bg-slate-100",
              ].join(" ")}
            >
              Day {i + 1}
              <span className="ml-1.5 text-[11px] opacity-70">
                {new Date(d + "T12:00:00Z").toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-4 px-6 py-4">
        {/* Unscheduled tray */}
        {view !== "conflicts" && (
          <aside className="w-64 shrink-0">
            <h2 className="mb-2 text-[13px] font-semibold">
              Not scheduled ({unscheduled.length})
            </h2>
            <div className="space-y-1.5">
              {unscheduled.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-[12px] text-slate-500">
                  Everything accepted has a slot.
                </p>
              ) : (
                unscheduled.map((s) => (
                  <div
                    key={s.id}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData(
                        "text/plain",
                        JSON.stringify({ id: s.id, format: s.format }),
                      )
                    }
                    onClick={() => setPicked(picked === s.id ? null : s.id)}
                    className={[
                      "cursor-grab rounded-lg border bg-white px-2.5 py-2 active:cursor-grabbing",
                      picked === s.id
                        ? "border-indigo-500 ring-2 ring-indigo-200"
                        : "border-slate-200 hover:border-slate-300",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-1.5">
                      {s.trackColor && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: s.trackColor }}
                        />
                      )}
                      <span className="font-mono text-[11px] text-slate-400">
                        {s.ref}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] font-medium leading-tight text-slate-900">
                      {s.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {s.format} · {durationFor(s.format)} min
                    </div>
                  </div>
                ))
              )}
            </div>
            {picked && (
              <p className="mt-2 rounded-md bg-indigo-50 px-2 py-1.5 text-[11px] text-indigo-700">
                Now click an empty slot in the grid.
              </p>
            )}
          </aside>
        )}

        <div className="min-w-0 flex-1">
          {view === "grid" && (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="w-20 border-b border-r border-slate-200 bg-slate-50/80 px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-slate-500">
                      Time
                    </th>
                    {roomList.map((r) => (
                      <th
                        key={r.id}
                        className="border-b border-r border-slate-200 bg-slate-50/80 px-2 py-1.5 text-left text-[12px] font-medium text-slate-700 last:border-r-0"
                      >
                        {r.name}
                        <span className="ml-1 font-normal text-slate-400">
                          {r.capacity}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {slots.map(({ hour, minute }) => {
                    const slotMs = slotToUtcMs(day, hour, minute);
                    return (
                      <tr key={`${hour}:${minute}`}>
                        <td className="border-b border-r border-slate-100 px-2 py-1 align-top text-[11px] tabular-nums text-slate-400">
                          {minute === 0 ? fmtTime(hour, minute) : ""}
                        </td>
                        {roomList.map((room) => {
                          const starting = onDay.find(
                            (s) => s.roomId === room.id && s.startMs === slotMs,
                          );
                          const covered = onDay.find(
                            (s) =>
                              s.roomId === room.id &&
                              s.startMs < slotMs &&
                              s.endMs > slotMs,
                          );

                          if (covered) return null;

                          if (starting) {
                            const span = Math.max(
                              1,
                              Math.round(
                                (starting.endMs - starting.startMs) /
                                  (SLOT_MINUTES * 60_000),
                              ),
                            );
                            const bad = conflictIds.has(starting.id);
                            return (
                              <td
                                key={room.id}
                                rowSpan={span}
                                className="border-b border-r border-slate-100 p-1 align-top last:border-r-0"
                              >
                                <div
                                  draggable
                                  onDragStart={(e) =>
                                    e.dataTransfer.setData(
                                      "text/plain",
                                      JSON.stringify({
                                        id: starting.id,
                                        format: starting.format,
                                      }),
                                    )
                                  }
                                  className={[
                                    "h-full cursor-grab rounded-md border-l-4 px-2 py-1.5 active:cursor-grabbing",
                                    bad
                                      ? "bg-rose-50 ring-1 ring-rose-300"
                                      : "bg-slate-50",
                                  ].join(" ")}
                                  style={{
                                    borderLeftColor:
                                      starting.trackColor ?? "#94a3b8",
                                  }}
                                >
                                  <div className="flex items-start justify-between gap-1">
                                    <span className="font-mono text-[10px] text-slate-400">
                                      {starting.ref}
                                    </span>
                                    <fetcher.Form method="post">
                                      <input
                                        type="hidden"
                                        name="intent"
                                        value="unschedule"
                                      />
                                      <input
                                        type="hidden"
                                        name="submissionId"
                                        value={starting.id}
                                      />
                                      <button
                                        title="Remove from schedule"
                                        className="text-[11px] leading-none text-slate-300 hover:text-rose-600"
                                      >
                                        ×
                                      </button>
                                    </fetcher.Form>
                                  </div>
                                  <div className="text-[12px] font-medium leading-tight text-slate-900">
                                    {starting.title}
                                  </div>
                                  <div className="mt-0.5 text-[11px] text-slate-500">
                                    {starting.speakers.map((s) => s.name).join(", ")}
                                  </div>
                                  {bad && (
                                    <div className="mt-1 text-[10px] font-medium text-rose-700">
                                      Conflict
                                    </div>
                                  )}
                                </div>
                              </td>
                            );
                          }

                          return (
                            <td
                              key={room.id}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => {
                                e.preventDefault();
                                try {
                                  const data = JSON.parse(
                                    e.dataTransfer.getData("text/plain"),
                                  );
                                  place(data.id, data.format, room.id, hour, minute);
                                } catch {
                                  /* ignore malformed drops */
                                }
                              }}
                              onClick={() => {
                                if (!picked) return;
                                const s =
                                  unscheduled.find((u) => u.id === picked) ??
                                  scheduled.find((u) => u.id === picked);
                                place(picked, s?.format ?? null, room.id, hour, minute);
                              }}
                              className={[
                                "h-8 border-b border-r border-slate-100 last:border-r-0",
                                picked
                                  ? "cursor-pointer bg-indigo-50/40 hover:bg-indigo-100"
                                  : "hover:bg-slate-50",
                              ].join(" ")}
                            />
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {view === "list" && (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {onDay.length === 0 ? (
                <p className="px-6 py-12 text-center text-[13px] text-slate-500">
                  Nothing scheduled on this day yet.
                </p>
              ) : (
                [...onDay]
                  .sort((a, b) => a.startMs - b.startMs)
                  .map((s) => {
                    const t = utcMsToLocalParts(s.startMs);
                    return (
                      <div
                        key={s.id}
                        className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0"
                      >
                        <span className="w-20 shrink-0 text-[12px] tabular-nums text-slate-500">
                          {fmtTime(t.hour, t.minute)}
                        </span>
                        <span
                          className="h-6 w-1 shrink-0 rounded"
                          style={{ background: s.trackColor ?? "#94a3b8" }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-slate-900">
                            {s.title}
                          </div>
                          <div className="text-[12px] text-slate-500">
                            {s.roomName} · {s.speakers.map((x) => x.name).join(", ")}
                          </div>
                        </div>
                        {conflictIds.has(s.id) && (
                          <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-700">
                            Conflict
                          </span>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          )}

          {view === "track" && (
            <div className="space-y-4">
              {[...new Set(scheduled.map((s) => s.trackName ?? "Unassigned"))].map(
                (name) => (
                  <div
                    key={name}
                    className="overflow-hidden rounded-lg border border-slate-200 bg-white"
                  >
                    <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-2 text-[13px] font-medium">
                      {name}
                    </div>
                    {scheduled
                      .filter((s) => (s.trackName ?? "Unassigned") === name)
                      .sort((a, b) => a.startMs - b.startMs)
                      .map((s) => {
                        const t = utcMsToLocalParts(s.startMs);
                        return (
                          <div
                            key={s.id}
                            className="flex gap-3 border-b border-slate-100 px-4 py-2 text-[13px] last:border-0"
                          >
                            <span className="w-32 shrink-0 tabular-nums text-slate-500">
                              {new Date(t.dayIso + "T12:00:00Z").toLocaleDateString(
                                "en-US",
                                { month: "short", day: "numeric" },
                              )}{" "}
                              {fmtTime(t.hour, t.minute)}
                            </span>
                            <span className="flex-1 font-medium text-slate-900">
                              {s.title}
                            </span>
                            <span className="text-slate-500">{s.roomName}</span>
                          </div>
                        );
                      })}
                  </div>
                ),
              )}
            </div>
          )}

          {view === "conflicts" && (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {conflicts.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white">
                    ✓
                  </div>
                  <p className="text-[14px] font-medium">No conflicts</p>
                  <p className="mt-1 text-[13px] text-slate-500">
                    No double-booked rooms, no speaker clashes, everything inside
                    event hours.
                  </p>
                </div>
              ) : (
                conflicts.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 border-b border-slate-100 px-4 py-3 last:border-0"
                  >
                    <span
                      className={[
                        "mt-1 h-2 w-2 shrink-0 rounded-full",
                        c.kind === "track" ? "bg-amber-400" : "bg-rose-500",
                      ].join(" ")}
                    />
                    <div>
                      <div className="text-[13px] text-slate-900">{c.message}</div>
                      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">
                        {c.kind === "room"
                          ? "Room double booked"
                          : c.kind === "speaker"
                            ? "Speaker double booked"
                            : c.kind === "track"
                              ? "Track collision"
                              : "Outside event hours"}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
