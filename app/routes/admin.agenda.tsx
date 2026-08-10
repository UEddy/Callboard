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
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  SLOT_MINUTES,
  detectConflicts,
  durationFor,
  eventDays,
  fmtTime,
  slotToUtcMs,
  utcMsToLocalParts,
  type Scheduled,
} from "~/lib/schedule";
import { safeZone } from "~/lib/tz";
import { readViewerZone } from "~/lib/viewer-tz";
import { EventTime } from "~/components/EventTime";
import { OptionsMenu } from "~/components/OptionsMenu";

/* --- Loader -------------------------------------------------------- */

export async function loader({ context, request }: LoaderFunctionArgs) {
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

  const zone = safeZone(event?.timezone);
  const dayIsos = eventDays(event?.startsAt ?? null, event?.endsAt ?? null, zone);

  const conflicts = detectConflicts(scheduled, dayIsos, zone);

  return {
    event,
    eventZone: zone,
    viewerZone: await readViewerZone(request),
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
    const ev = await db.query.events.findFirst({
      where: eq(events.id, DEMO_EVENT_ID),
    });
    const zone = safeZone(ev?.timezone);
    const roomId = String(fd.get("roomId"));
    const dayIso = String(fd.get("dayIso"));
    const hour = Number(fd.get("hour"));
    const minute = Number(fd.get("minute"));
    const format = String(fd.get("format") ?? "");

    const startMs = slotToUtcMs(dayIso, hour, minute, zone);
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
  const {
    event,
    eventZone,
    viewerZone,
    roomList,
    scheduled,
    unscheduled,
    dayIsos,
    conflicts,
    ms,
  } = useLoaderData<typeof loader>();
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
    (s) => utcMsToLocalParts(s.startMs, eventZone).dayIso === day,
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
      <div className="border-b border-line bg-surface px-6 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Agenda</h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Drag a session onto a slot, or click it then click where it goes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {conflicts.length > 0 && (
              <span className="rounded-md bg-danger-soft px-2 py-1 text-[12px] font-medium text-danger ring-1 ring-inset ring-danger-ring">
                {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}
              </span>
            )}
            <OptionsMenu
              source="agenda"
              rowCount={
                view === "conflicts"
                  ? new Set(conflicts.flatMap((c) => c.submissionIds)).size
                  : view === "grid" || view === "list"
                    ? onDay.length
                    : scheduled.length
              }
              scopeNote={
                view === "conflicts"
                  ? "Only the sessions involved in a conflict."
                  : view === "grid" || view === "list"
                    ? `Scheduled sessions on the selected day.`
                    : "Every scheduled session."
              }
            />
            <span className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
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
                  ? "border-accent-solid font-medium text-accent-text"
                  : "border-transparent text-dim hover:text-strong",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {(view === "grid" || view === "list") && dayIsos.length > 0 && (
        <div className="flex gap-2 border-b border-line bg-surface px-6 py-2">
          {dayIsos.map((d, i) => (
            <button
              key={d}
              onClick={() => setDay(d)}
              className={[
                "rounded-md px-2.5 py-1 text-[13px]",
                d === day
                  ? "bg-invert font-medium text-invert-fg"
                  : "text-body hover:bg-muted",
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
                <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[12px] text-dim">
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
                      "cursor-grab rounded-lg border bg-surface px-2.5 py-2 active:cursor-grabbing",
                      picked === s.id
                        ? "border-accent-solid ring-2 ring-accent-ring"
                        : "border-line hover:border-line-strong",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-1.5">
                      {s.trackColor && (
                        <span
                          className="cb-dot h-2 w-2 shrink-0"
                          style={{ ["--cb-hue"]: s.trackColor } as React.CSSProperties}
                        />
                      )}
                      <span className="font-mono text-[11px] text-faint">
                        {s.ref}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] font-medium leading-tight text-strong">
                      {s.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-dim">
                      {s.format} · {durationFor(s.format)} min
                    </div>
                  </div>
                ))
              )}
            </div>
            {picked && (
              <p className="mt-2 rounded-md bg-accent-soft px-2 py-1.5 text-[11px] text-accent-text">
                Now click an empty slot in the grid.
              </p>
            )}
          </aside>
        )}

        <div className="min-w-0 flex-1">
          {view === "grid" && (
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="w-20 border-b border-r border-line bg-subtle px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-dim">
                      Time
                    </th>
                    {roomList.map((r) => (
                      <th
                        key={r.id}
                        className="border-b border-r border-line bg-subtle px-2 py-1.5 text-left text-[12px] font-medium text-body last:border-r-0"
                      >
                        {r.name}
                        <span className="ml-1 font-normal text-faint">
                          {r.capacity}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {slots.map(({ hour, minute }) => {
                    const slotMs = slotToUtcMs(day, hour, minute, eventZone);
                    return (
                      <tr key={`${hour}:${minute}`}>
                        <td className="border-b border-r border-line-soft px-2 py-1 align-top text-[11px] tabular-nums text-faint">
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
                                className="border-b border-r border-line-soft p-1 align-top last:border-r-0"
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
                                    "cb-track-edge h-full cursor-grab rounded-md border-l-4 px-2 py-1.5 active:cursor-grabbing",
                                    bad
                                      ? "bg-danger-soft ring-1 ring-danger-ring"
                                      : "bg-subtle",
                                  ].join(" ")}
                                  style={
                                    {
                                      "--cb-hue":
                                        starting.trackColor ?? "#94a3b8",
                                    } as React.CSSProperties
                                  }
                                >
                                  <div className="flex items-start justify-between gap-1">
                                    <span className="font-mono text-[10px] text-faint">
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
                                        className="text-[11px] leading-none text-faint hover:text-danger"
                                      >
                                        ×
                                      </button>
                                    </fetcher.Form>
                                  </div>
                                  <div className="text-[12px] font-medium leading-tight text-strong">
                                    {starting.title}
                                  </div>
                                  <div className="mt-0.5 text-[11px] text-dim">
                                    {starting.speakers.map((s) => s.name).join(", ")}
                                  </div>
                                  {bad && (
                                    <div className="mt-1 text-[10px] font-medium text-danger">
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
                                "h-8 border-b border-r border-line-soft last:border-r-0",
                                picked
                                  ? "cursor-pointer bg-accent-soft hover:bg-accent-soft-strong"
                                  : "hover:bg-subtle",
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
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {onDay.length === 0 ? (
                <p className="px-6 py-12 text-center text-[13px] text-dim">
                  Nothing scheduled on this day yet.
                </p>
              ) : (
                [...onDay]
                  .sort((a, b) => a.startMs - b.startMs)
                  .map((s) => {
                    const t = utcMsToLocalParts(s.startMs, eventZone);
                    return (
                      <div
                        key={s.id}
                        className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0"
                      >
                        <span className="w-20 shrink-0 text-[12px] tabular-nums text-dim">
                          {fmtTime(t.hour, t.minute)}
                        </span>
                        <span
                          className="cb-bar h-6 w-1 shrink-0 rounded"
                          style={{ ["--cb-hue"]: s.trackColor ?? "#94a3b8" } as React.CSSProperties}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-strong">
                            {s.title}
                          </div>
                          <div className="text-[12px] text-dim">
                            {s.roomName} · {s.speakers.map((x) => x.name).join(", ")}
                          </div>
                        </div>
                        {conflictIds.has(s.id) && (
                          <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger">
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
                    className="overflow-hidden rounded-lg border border-line bg-surface"
                  >
                    <div className="border-b border-line-soft bg-subtle px-4 py-2 text-[13px] font-medium">
                      {name}
                    </div>
                    {scheduled
                      .filter((s) => (s.trackName ?? "Unassigned") === name)
                      .sort((a, b) => a.startMs - b.startMs)
                      .map((s) => {
                        const t = utcMsToLocalParts(s.startMs, eventZone);
                        return (
                          <div
                            key={s.id}
                            className="flex gap-3 border-b border-line-soft px-4 py-2 text-[13px] last:border-0"
                          >
                            <span className="w-32 shrink-0 tabular-nums text-dim">
                              {new Date(t.dayIso + "T12:00:00Z").toLocaleDateString(
                                "en-US",
                                { month: "short", day: "numeric" },
                              )}{" "}
                              {fmtTime(t.hour, t.minute)}
                            </span>
                            <span className="flex-1 font-medium text-strong">
                              {s.title}
                            </span>
                            <span className="text-dim">{s.roomName}</span>
                          </div>
                        );
                      })}
                  </div>
                ),
              )}
            </div>
          )}

          {view === "conflicts" && (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {conflicts.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-success-solid text-on-solid">
                    ✓
                  </div>
                  <p className="text-[14px] font-medium">No conflicts</p>
                  <p className="mt-1 text-[13px] text-dim">
                    No double-booked rooms, no speaker clashes, everything inside
                    event hours.
                  </p>
                </div>
              ) : (
                conflicts.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 border-b border-line-soft px-4 py-3 last:border-0"
                  >
                    <span
                      className={[
                        "mt-1 h-2 w-2 shrink-0 rounded-full",
                        c.kind === "track" ? "bg-warn-solid" : "bg-danger-solid",
                      ].join(" ")}
                    />
                    <div>
                      <div className="text-[13px] text-strong">{c.message}</div>
                      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-faint">
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
