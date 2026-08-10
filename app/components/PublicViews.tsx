import {
  fmtDay,
  fmtTime,
  localDay,
  localParts,
  type FieldToggles,
  type PublicSession,
  type PublicSpeaker,
} from "~/lib/public-event";

/* ------------------------------------------------------------------ *
 * The five public views.
 *
 * Shared by the standalone page and the iframe embed so an organiser
 * previewing a view in the admin is looking at the same component their
 * visitors get, not an approximation of it.
 *
 * These render inside someone else's page, so they carry no fixed
 * width, no page chrome, and no assumptions about the surrounding
 * background beyond the theme tokens.
 * ------------------------------------------------------------------ */

type Data = {
  sessions: PublicSession[];
  speakers: (PublicSpeaker & { sessions: { ref: string; title: string }[] })[];
  rooms: { id: string; name: string; capacity: number | null }[];
  days: string[];
  fields: FieldToggles;
};

const hue = (c: string | null) =>
  ({ "--cb-hue": c ?? "#94a3b8" }) as React.CSSProperties;

function Empty({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="text-[14px] font-medium text-strong">Nothing to show yet</p>
      <p className="mt-1 text-[13px] text-dim">
        {what} appear here once the programme is published.
      </p>
    </div>
  );
}

function TrackTag({ session }: { session: PublicSession }) {
  if (!session.trackName) return null;
  return (
    <span className="cb-chip" style={hue(session.trackColor)}>
      {session.trackName}
    </span>
  );
}

function Speakers({ session }: { session: PublicSession }) {
  if (session.speakers.length === 0) return null;
  return (
    <span className="text-[13px] text-dim">
      {session.speakers.map((s) => s.name).join(", ")}
    </span>
  );
}

/* --- 1. Sessions list ------------------------------------------------ */

export function SessionList({ sessions, fields }: Data) {
  if (sessions.length === 0) return <Empty what="Sessions" />;
  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
      {sessions.map((s) => (
        <li key={s.id} className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            {fields.showTrack && <TrackTag session={s} />}
            {fields.showFormat && s.format && (
              <span className="cb-pill cb-pill-neutral">{s.format}</span>
            )}
            {fields.showLevel && s.level && (
              <span className="cb-pill cb-pill-neutral">{s.level}</span>
            )}
          </div>
          <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight text-strong">
            {s.title}
          </h3>
          {fields.showSpeakers && (
            <div className="mt-0.5">
              <Speakers session={s} />
            </div>
          )}
          {fields.showAbstract && s.abstract && (
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-body">
              {s.abstract}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-dim tabular-nums">
            {s.startsAt !== null && (
              <span>
                {fmtDay(localDay(s.startsAt))}, {fmtTime(s.startsAt)}
              </span>
            )}
            {fields.showRoom && s.roomName && <span>{s.roomName}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* --- 2. Speakers list ------------------------------------------------ */

export function SpeakerList({ speakers, fields }: Data) {
  if (speakers.length === 0) return <Empty what="Speakers" />;
  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
      {speakers.map((sp) => (
        <li key={sp.id} className="flex gap-3 p-4">
          {sp.headshotUrl ? (
            <img
              src={sp.headshotUrl}
              alt=""
              loading="lazy"
              className="h-11 w-11 shrink-0 rounded-full object-cover ring-1 ring-line"
            />
          ) : (
            <div
              aria-hidden
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-medium text-dim"
            >
              {sp.name.slice(0, 1) || "?"}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-[14px] font-semibold tracking-tight text-strong">
              {sp.name}
            </div>
            {fields.showCompany && (sp.jobTitle || sp.company) && (
              <div className="text-[13px] text-dim">
                {[sp.jobTitle, sp.company].filter(Boolean).join(", ")}
              </div>
            )}
            {fields.showBio && sp.bio && (
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-body">
                {sp.bio}
              </p>
            )}
            <div className="mt-1 space-y-0.5">
              {sp.sessions.map((s) => (
                <div key={s.ref} className="text-[12px] text-dim">
                  {s.title}
                </div>
              ))}
            </div>
            {fields.showLinks && <Links links={sp.links} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Links({ links }: { links: Record<string, string> }) {
  const entries = Object.entries(links).filter(([, v]) => v);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {entries.map(([k, v]) => (
        <a
          key={k}
          href={v}
          target="_blank"
          rel="noreferrer nofollow"
          className="text-[12px] text-accent-text underline underline-offset-2"
        >
          {k}
        </a>
      ))}
    </div>
  );
}

/* --- 3. Agenda grid --------------------------------------------------- */

const SLOT_MINUTES = 30;

export function AgendaGrid({ sessions, rooms, days, fields }: Data) {
  const placed = sessions.filter((s) => s.startsAt !== null && s.roomId);
  if (placed.length === 0) return <Empty what="Scheduled sessions" />;

  const usedRooms = rooms.filter((r) => placed.some((s) => s.roomId === r.id));
  const dayList = days.length
    ? days
    : [...new Set(placed.map((s) => localDay(s.startsAt!)))].sort();

  return (
    <div className="space-y-6">
      {dayList.map((day) => {
        const onDay = placed.filter((s) => localDay(s.startsAt!) === day);
        if (onDay.length === 0) return null;

        const starts = onDay.map((s) => localParts(s.startsAt!));
        const firstHour = Math.min(...starts.map((p) => p.hour));
        const lastEnd = Math.max(
          ...onDay.map((s) => {
            const e = localParts(s.endsAt ?? s.startsAt! + 30 * 60_000);
            return e.hour * 60 + e.minute;
          }),
        );

        const slots: { hour: number; minute: number }[] = [];
        for (let m = firstHour * 60; m < lastEnd; m += SLOT_MINUTES) {
          slots.push({ hour: Math.floor(m / 60), minute: m % 60 });
        }

        return (
          <section key={day}>
            <h3 className="mb-2 text-[14px] font-semibold tracking-tight text-strong">
              {fmtDay(day)}
            </h3>
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="cb-thead w-20 border-r border-line px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.06em]">
                      Time
                    </th>
                    {usedRooms.map((r) => (
                      <th
                        key={r.id}
                        className="cb-thead border-r border-line px-2 py-1.5 text-left text-[12px] font-medium text-strong last:border-r-0"
                      >
                        {r.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {slots.map(({ hour, minute }) => {
                    const slotMin = hour * 60 + minute;
                    return (
                      <tr key={slotMin}>
                        <td className="border-b border-r border-line-soft px-2 py-1 align-top text-[11px] tabular-nums text-faint">
                          {minute === 0
                            ? `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`
                            : ""}
                        </td>
                        {usedRooms.map((room) => {
                          const inRoom = onDay.filter(
                            (s) => s.roomId === room.id,
                          );
                          const starting = inRoom.find((s) => {
                            const p = localParts(s.startsAt!);
                            return p.hour * 60 + p.minute === slotMin;
                          });
                          const covered = inRoom.find((s) => {
                            const p = localParts(s.startsAt!);
                            const st = p.hour * 60 + p.minute;
                            const e = localParts(
                              s.endsAt ?? s.startsAt! + 30 * 60_000,
                            );
                            const en = e.hour * 60 + e.minute;
                            return st < slotMin && en > slotMin;
                          });
                          if (covered) return null;

                          if (starting) {
                            const e = localParts(
                              starting.endsAt ??
                                starting.startsAt! + 30 * 60_000,
                            );
                            const span = Math.max(
                              1,
                              Math.round(
                                (e.hour * 60 + e.minute - slotMin) /
                                  SLOT_MINUTES,
                              ),
                            );
                            return (
                              <td
                                key={room.id}
                                rowSpan={span}
                                className="border-b border-r border-line-soft p-1 align-top last:border-r-0"
                              >
                                <div
                                  className="cb-track-edge h-full rounded-md border-l-4 bg-subtle px-2 py-1.5"
                                  style={hue(starting.trackColor)}
                                >
                                  <div className="text-[12px] font-medium leading-tight text-strong">
                                    {starting.title}
                                  </div>
                                  {fields.showSpeakers &&
                                    starting.speakers.length > 0 && (
                                      <div className="mt-0.5 text-[11px] text-dim">
                                        {starting.speakers
                                          .map((s) => s.name)
                                          .join(", ")}
                                      </div>
                                    )}
                                  {fields.showTrack && starting.trackName && (
                                    <div className="mt-0.5 text-[11px] text-dim">
                                      {starting.trackName}
                                    </div>
                                  )}
                                </div>
                              </td>
                            );
                          }

                          return (
                            <td
                              key={room.id}
                              className="h-8 border-b border-r border-line-soft last:border-r-0"
                            />
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* --- 4. Schedule itinerary -------------------------------------------- */

export function ScheduleItinerary({ sessions, days, fields }: Data) {
  const timed = sessions.filter((s) => s.startsAt !== null);
  if (timed.length === 0) return <Empty what="Scheduled sessions" />;

  const dayList = days.length
    ? days
    : [...new Set(timed.map((s) => localDay(s.startsAt!)))].sort();

  return (
    <div className="space-y-6">
      {dayList.map((day) => {
        const onDay = timed
          .filter((s) => localDay(s.startsAt!) === day)
          .sort((a, b) => a.startsAt! - b.startsAt!);
        if (onDay.length === 0) return null;

        return (
          <section key={day}>
            <h3 className="mb-2 text-[14px] font-semibold tracking-tight text-strong">
              {fmtDay(day)}
            </h3>
            <ol className="overflow-hidden rounded-lg border border-line bg-surface">
              {onDay.map((s) => (
                <li
                  key={s.id}
                  className="flex gap-3 border-b border-line-soft p-3 last:border-0"
                >
                  <div className="w-20 shrink-0 pt-0.5 text-[12px] tabular-nums text-dim">
                    {fmtTime(s.startsAt)}
                  </div>
                  <div
                    className="cb-bar w-1 shrink-0 rounded"
                    style={hue(s.trackColor)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-strong">
                      {s.title}
                    </div>
                    {fields.showSpeakers && (
                      <div className="mt-0.5">
                        <Speakers session={s} />
                      </div>
                    )}
                    {fields.showAbstract && s.abstract && (
                      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-body">
                        {s.abstract}
                      </p>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-dim">
                      {fields.showRoom && s.roomName && (
                        <span>{s.roomName}</span>
                      )}
                      {fields.showTrack && s.trackName && (
                        <span>{s.trackName}</span>
                      )}
                      {fields.showLevel && s.level && <span>{s.level}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/* --- 5. Speaker gallery ------------------------------------------------ */

export function SpeakerGallery({ speakers, fields }: Data) {
  if (speakers.length === 0) return <Empty what="Speakers" />;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {speakers.map((sp) => (
        <li
          key={sp.id}
          className="overflow-hidden rounded-lg border border-line bg-surface p-4 text-center"
        >
          {sp.headshotUrl ? (
            <img
              src={sp.headshotUrl}
              alt=""
              loading="lazy"
              className="mx-auto h-20 w-20 rounded-full object-cover ring-1 ring-line"
            />
          ) : (
            <div
              aria-hidden
              className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-muted text-[20px] font-medium text-dim"
            >
              {sp.name.slice(0, 1) || "?"}
            </div>
          )}
          <div className="mt-2 text-[14px] font-semibold tracking-tight text-strong">
            {sp.name}
          </div>
          {fields.showCompany && (sp.jobTitle || sp.company) && (
            <div className="text-[12px] text-dim">
              {[sp.jobTitle, sp.company].filter(Boolean).join(", ")}
            </div>
          )}
          {fields.showBio && sp.bio && (
            <p className="mt-1.5 line-clamp-4 text-left text-[12px] leading-relaxed text-body">
              {sp.bio}
            </p>
          )}
          {fields.showLinks && (
            <div className="mt-1 flex justify-center">
              <Links links={sp.links} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function renderView(view: string, data: Data) {
  switch (view) {
    case "session_list":
      return <SessionList {...data} />;
    case "speaker_list":
      return <SpeakerList {...data} />;
    case "schedule_itinerary":
      return <ScheduleItinerary {...data} />;
    case "speaker_gallery":
      return <SpeakerGallery {...data} />;
    case "agenda":
    default:
      return <AgendaGrid {...data} />;
  }
}
