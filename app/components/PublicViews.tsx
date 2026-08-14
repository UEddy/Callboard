import { useEffect, useRef, useState } from "react";
import { Form, Link } from "react-router";
import { EventTime } from "~/components/EventTime";
import {
  fmtDay,
  fmtRangeIn,
  fmtTime,
  localDay,
  localParts,
  type FieldToggles,
  type PublicLinks,
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
  eventZone: string;
  viewerZone: string | null;
  sessions: PublicSession[];
  speakers: (PublicSpeaker & { sessions: { ref: string; title: string }[] })[];
  rooms: { id: string; name: string; capacity: number | null }[];
  days: string[];
  fields: FieldToggles;
  /* What the visitor searched for, so an empty list can tell them their
     search found nothing rather than implying the programme is not out
     yet. */
  query?: string;
  /* How to reach the detail pages from here. Absent means render the
     same content as plain text, which is what the admin's preview frames
     want: a producer checking a layout should not be able to click out
     of the thing they are previewing. */
  links?: PublicLinks;
};

/* A heading that becomes a link when there is somewhere to go. */
function MaybeLink({
  to,
  className,
  children,
}: {
  to?: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (!to) return <span className={className}>{children}</span>;
  return (
    <Link to={to} className={className} prefetch="intent">
      {children}
    </Link>
  );
}

const hue = (c: string | null) =>
  ({ "--cb-hue": c ?? "#94a3b8" }) as React.CSSProperties;

function Empty({ what, query }: { what: string; query?: string }) {
  if (query) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
        <p className="text-[14px] font-medium text-strong">
          Nothing matches “{query}”
        </p>
        <p className="mt-1 text-[13px] text-dim">
          {what} are searched by title and by speaker name. Try a shorter
          word, or clear the search.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="text-[14px] font-medium text-strong">Nothing to show yet</p>
      <p className="mt-1 text-[13px] text-dim">
        {what} appear here once the programme is published.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The search control.
 *
 * One component for the sessions list, the speakers list and the
 * speaker gallery, because it is one behaviour: the query goes to the
 * server, narrows both sessions and speakers, and the count beside it is
 * the number of things actually on screen. Three copies would be three
 * chances for the views to disagree about what a search means.
 *
 * A plain GET form, so it works with no JavaScript and leaves a URL a
 * visitor can bookmark or share. The other filters ride along as hidden
 * fields rather than being dropped on submit.
 * ------------------------------------------------------------------ */
export function PublicSearch({
  query,
  count,
  noun,
  hidden,
  clearHref,
}: {
  query: string;
  count: number;
  noun: "session" | "speaker";
  /* track, day, and anything else the current URL is carrying. */
  hidden: Record<string, string>;
  clearHref: string;
}) {
  return (
    <Form method="get" className="flex flex-wrap items-center gap-2" role="search">
      {Object.entries(hidden).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <input
        type="search"
        name="q"
        defaultValue={query}
        placeholder="Search sessions and speakers"
        aria-label="Search sessions and speakers"
        className="w-56 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[13px] text-strong outline-none placeholder:text-faint focus:border-accent-solid focus:ring-2 focus:ring-accent-ring"
      />
      <button
        type="submit"
        className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[13px] font-medium text-body hover:bg-subtle"
      >
        Search
      </button>
      <span className="text-[12px] tabular-nums text-dim">
        {count} {noun}
        {count === 1 ? "" : "s"}
        {query && ` matching “${query}”`}
      </span>
      {query && (
        /* A link, not a second submit button: a button named q would put
           two q values in the query string and the first one wins. */
        <Link
          to={clearHref}
          className="text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
        >
          Clear
        </Link>
      )}
    </Form>
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

/* "Staff Engineer, Vectorworks", or nothing when a speaker has given
   neither. */
function roleOf(sp: PublicSpeaker) {
  return [sp.jobTitle, sp.company].filter(Boolean).join(", ");
}

/* One speaker per line, name then who they are. A visitor scanning a
   programme is deciding whether a talk is worth their next hour, and
   "Staff Engineer at the company that makes the thing" is most of that
   decision. Joined onto one comma-separated line it stops being
   readable as soon as two speakers both have titles. */
function Speakers({
  session,
  showRole,
}: {
  session: PublicSession;
  showRole: boolean;
}) {
  if (session.speakers.length === 0) return null;
  return (
    <ul className="text-[13px] leading-snug">
      {session.speakers.map((sp) => {
        const role = showRole ? roleOf(sp) : "";
        return (
          <li key={sp.id}>
            <span className="text-body">{sp.name}</span>
            {role && <span className="text-dim"> — {role}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/* Roughly three lines at the width these lists render at. Only a first
   guess: the same paragraph is three lines on a laptop and seven on a
   phone, so the real decision is made by measuring after mount. Erring
   low means an occasional toggle that has nothing to reveal, which is
   better than an abstract clipped with no way to open it. */
const CLAMP_HINT_CHARS = 150;

/* A session description, clamped with a toggle.
 *
 * The toggle is a hidden checkbox and two labels rather than component
 * state, so it works with no JavaScript at all: this page is public,
 * cached at the edge, and often read inside somebody else's iframe. The
 * only thing JavaScript does here is decide whether the toggle is worth
 * showing, by asking the browser whether the text is actually clipped.
 */
function Abstract({
  id,
  text,
  lines = 3,
  className = "mt-2",
}: {
  id: string;
  text: string;
  lines?: 2 | 3;
  className?: string;
}) {
  const box = useRef<HTMLParagraphElement>(null);
  const toggle = useRef<HTMLInputElement>(null);
  const [clipped, setClipped] = useState(text.length > CLAMP_HINT_CHARS);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      // Meaningless once expanded: nothing is clipped, and hiding the
      // toggle then would strand the reader with no way back.
      if (toggle.current?.checked) return;
      setClipped(el.scrollHeight - el.clientHeight > 2);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text]);

  return (
    <div className={className}>
      <input
        ref={toggle}
        type="checkbox"
        id={id}
        className="peer sr-only"
        aria-label={`Show the full description of ${text.slice(0, 40)}…`}
      />
      <p
        ref={box}
        className={[
          lines === 2 ? "line-clamp-2" : "line-clamp-3",
          "whitespace-pre-wrap text-[13px] leading-relaxed text-body peer-checked:line-clamp-none",
        ].join(" ")}
      >
        {text}
      </p>
      {clipped && (
        <>
          {/* Two labels rather than one with swapped text: Tailwind's
              peer- variants reach siblings of the checkbox, not the
              children of a sibling. */}
          <label
            htmlFor={id}
            className="mt-0.5 inline-block cursor-pointer text-[12px] font-medium text-accent-text underline-offset-2 hover:underline peer-checked:hidden"
          >
            Show more
          </label>
          <label
            htmlFor={id}
            className="mt-0.5 hidden cursor-pointer text-[12px] font-medium text-accent-text underline-offset-2 hover:underline peer-checked:inline-block"
          >
            Show less
          </label>
        </>
      )}
    </div>
  );
}

/* --- 1. Sessions list ------------------------------------------------ */

export function SessionList({
  sessions,
  fields,
  eventZone,
  query,
  links,
}: Data) {
  if (sessions.length === 0) return <Empty what="Sessions" query={query} />;
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
            <MaybeLink
              to={links?.session(s.ref)}
              className="underline-offset-2 hover:underline"
            >
              {s.title}
            </MaybeLink>
          </h3>
          {fields.showSpeakers && (
            <div className="mt-1">
              <Speakers session={s} showRole={fields.showCompany} />
            </div>
          )}
          {fields.showAbstract && s.abstract && (
            <Abstract id={`abs-list-${s.id}`} text={s.abstract} />
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-dim tabular-nums">
            {s.startsAt !== null && (
              <span>
                {fmtDay(localDay(s.startsAt, eventZone))}, {fmtTime(s.startsAt, eventZone)}
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

export function SpeakerList({ speakers, fields, query, links }: Data) {
  if (speakers.length === 0) return <Empty what="Speakers" query={query} />;
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
              <MaybeLink
                to={links?.speaker(sp.id)}
                className="underline-offset-2 hover:underline"
              >
                {sp.name}
              </MaybeLink>
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
                  <MaybeLink
                    to={links?.session(s.ref)}
                    className="underline-offset-2 hover:text-strong hover:underline"
                  >
                    {s.title}
                  </MaybeLink>
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

export function AgendaGrid({
  sessions,
  rooms,
  days,
  fields,
  eventZone,
  links,
}: Data) {
  const placed = sessions.filter((s) => s.startsAt !== null && s.roomId);
  if (placed.length === 0) return <Empty what="Scheduled sessions" />;

  const usedRooms = rooms.filter((r) => placed.some((s) => s.roomId === r.id));
  const dayList = days.length
    ? days
    : [...new Set(placed.map((s) => localDay(s.startsAt!, eventZone)))].sort();

  return (
    <div className="space-y-6">
      {dayList.map((day) => {
        const onDay = placed.filter((s) => localDay(s.startsAt!, eventZone) === day);
        if (onDay.length === 0) return null;

        const starts = onDay.map((s) => localParts(s.startsAt!, eventZone));
        const firstHour = Math.min(...starts.map((p) => p.hour));
        const lastEnd = Math.max(
          ...onDay.map((s) => {
            const e = localParts(s.endsAt ?? s.startsAt! + 30 * 60_000, eventZone);
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
                            const p = localParts(s.startsAt!, eventZone);
                            return p.hour * 60 + p.minute === slotMin;
                          });
                          const covered = inRoom.find((s) => {
                            const p = localParts(s.startsAt!, eventZone);
                            const st = p.hour * 60 + p.minute;
                            const e = localParts(
                              s.endsAt ?? s.startsAt! + 30 * 60_000,
                              eventZone,
                            );
                            const en = e.hour * 60 + e.minute;
                            return st < slotMin && en > slotMin;
                          });
                          if (covered) return null;

                          if (starting) {
                            const e = localParts(
                              starting.endsAt ??
                                starting.startsAt! + 30 * 60_000,
                              eventZone,
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
                                    <MaybeLink
                                      to={links?.session(starting.ref)}
                                      className="underline-offset-2 hover:underline"
                                    >
                                      {starting.title}
                                    </MaybeLink>
                                  </div>
                                  {fields.showSpeakers &&
                                    starting.speakers.length > 0 && (
                                      <ul className="mt-0.5 text-[11px] leading-snug text-dim">
                                        {starting.speakers.map((sp) => {
                                          /* A grid cell is as tall as the
                                             session is long. One slot is
                                             barely two lines, so the
                                             titles only appear on blocks
                                             with room for them. */
                                          const role =
                                            fields.showCompany && span >= 2
                                              ? roleOf(sp)
                                              : "";
                                          return (
                                            <li key={sp.id}>
                                              {sp.name}
                                              {role && (
                                                <span className="text-faint">
                                                  {" "}
                                                  — {role}
                                                </span>
                                              )}
                                            </li>
                                          );
                                        })}
                                      </ul>
                                    )}
                                  {fields.showTrack && starting.trackName && (
                                    <div className="mt-0.5 text-[11px] text-dim">
                                      {starting.trackName}
                                    </div>
                                  )}
                                  {/* Only a workshop-sized block has the
                                      height for prose, and it is clamped
                                      with no toggle on purpose: expanding
                                      a cell would push every other
                                      column's rows out of line and the
                                      grid would stop being a grid. The
                                      full text is one click away on the
                                      sessions list. */}
                                  {fields.showAbstract &&
                                    starting.abstract &&
                                    span >= 3 && (
                                      <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-dim">
                                        {starting.abstract}
                                      </p>
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

export function ScheduleItinerary({
  sessions,
  days,
  fields,
  eventZone,
  viewerZone,
  links,
}: Data) {
  const timed = sessions.filter((s) => s.startsAt !== null);
  if (timed.length === 0) return <Empty what="Scheduled sessions" />;

  const dayList = days.length
    ? days
    : [...new Set(timed.map((s) => localDay(s.startsAt!, eventZone)))].sort();

  return (
    <div className="space-y-6">
      {dayList.map((day) => {
        const onDay = timed
          .filter((s) => localDay(s.startsAt!, eventZone) === day)
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
                    {fmtTime(s.startsAt, eventZone)}
                  </div>
                  <div
                    className="cb-bar w-1 shrink-0 rounded"
                    style={hue(s.trackColor)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-strong">
                      <MaybeLink
                        to={links?.session(s.ref)}
                        className="underline-offset-2 hover:underline"
                      >
                        {s.title}
                      </MaybeLink>
                    </div>
                    {fields.showSpeakers && (
                      <div className="mt-1">
                        <Speakers session={s} showRole={fields.showCompany} />
                      </div>
                    )}
                    {fields.showAbstract && s.abstract && (
                      <Abstract
                        id={`abs-itin-${s.id}`}
                        text={s.abstract}
                        className="mt-1.5"
                      />
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

export function SpeakerGallery({ speakers, fields, query, links }: Data) {
  if (speakers.length === 0) return <Empty what="Speakers" query={query} />;
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
            <MaybeLink
              to={links?.speaker(sp.id)}
              className="underline-offset-2 hover:underline"
            >
              {sp.name}
            </MaybeLink>
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

/* ------------------------------------------------------------------ *
 * The page around a detail view.
 *
 * Embedded, it is the content and nothing else, the same contract the
 * list views have: no header, no footer, nothing that fights the host
 * page. Standalone it gets the event's name and a Back link that goes
 * where the visitor came from.
 * ------------------------------------------------------------------ */
export function PublicDetailPage({
  eventName,
  eventSlug,
  back,
  embed,
  ms,
  children,
}: {
  eventName: string;
  eventSlug: string;
  back: { href: string; label: string };
  embed: boolean;
  ms: number;
  children: React.ReactNode;
}) {
  if (embed) {
    return (
      <div className="bg-canvas p-3 text-strong">
        <Link
          to={back.href}
          className="mb-2 inline-block text-[12px] text-accent-text underline-offset-2 hover:underline"
        >
          ← Back to {back.label.toLowerCase()}
        </Link>
        {children}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-strong">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-3xl px-4 py-5">
          <Link
            to={`/e/${eventSlug}`}
            className="text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
          >
            {eventName}
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-5">
        <Link
          to={back.href}
          prefetch="intent"
          className="mb-3 inline-block text-[13px] text-accent-text underline-offset-2 hover:underline"
        >
          ← Back to {back.label.toLowerCase()}
        </Link>

        {children}

        <p className="mt-6 text-[12px] text-faint">
          Powered by Callboard
          <span className="ml-2 font-mono tabular-nums">{ms} ms</span>
        </p>
      </div>
    </div>
  );
}

/* --- 6. Session detail ------------------------------------------------ */

function SpeakerCard({
  sp,
  href,
  fields,
}: {
  sp: PublicSpeaker;
  href?: string;
  fields: FieldToggles;
}) {
  const role = roleOf(sp);
  return (
    <li className="flex gap-3">
      {sp.headshotUrl ? (
        <img
          src={sp.headshotUrl}
          alt=""
          loading="lazy"
          className="h-12 w-12 shrink-0 rounded-full object-cover ring-1 ring-line"
        />
      ) : (
        <div
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-[14px] font-medium text-dim"
        >
          {sp.name.slice(0, 1) || "?"}
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[14px] font-semibold tracking-tight text-strong">
          <MaybeLink to={href} className="underline-offset-2 hover:underline">
            {sp.name}
          </MaybeLink>
        </div>
        {role && <div className="text-[13px] text-dim">{role}</div>}
        {sp.bio && (
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-body">
            {sp.bio}
          </p>
        )}
        {fields.showLinks && <Links links={sp.links} />}
      </div>
    </li>
  );
}

export function SessionDetail({
  session,
  eventZone,
  viewerZone,
  fields,
  links,
}: {
  session: PublicSession;
  eventZone: string;
  viewerZone: string | null;
  fields: FieldToggles;
  links?: PublicLinks;
}) {
  const facts = [
    ["Track", session.trackName],
    ["Format", session.format],
    ["Level", session.level],
    ["Room", session.roomName],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="border-b border-line-soft p-4">
        <div className="flex flex-wrap items-center gap-2">
          <TrackTag session={session} />
          {session.format && (
            <span className="cb-pill cb-pill-neutral">{session.format}</span>
          )}
          {session.level && (
            <span className="cb-pill cb-pill-neutral">{session.level}</span>
          )}
        </div>
        <h2 className="mt-2 text-[20px] font-semibold tracking-tight text-strong">
          {session.title}
        </h2>
        <div className="mt-1 text-[13px] text-body">
          {session.startsAt === null ? (
            "Time to be confirmed"
          ) : (
            <>
              {fmtDay(localDay(session.startsAt, eventZone))} ·{" "}
              {fmtRangeIn(session.startsAt, session.endsAt, eventZone)}
            </>
          )}
          {session.roomName && (
            <span className="text-dim"> · {session.roomName}</span>
          )}
          {/* The event's clock is the reading above. This adds the
              visitor's own, and only when it differs from it. */}
          <EventTime
            utcMs={session.startsAt}
            eventZone={eventZone}
            viewerZone={viewerZone}
            secondaryOnly
            className="ml-1 text-dim"
          />
        </div>
      </div>

      {session.abstract && (
        <div className="border-b border-line-soft p-4">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-body">
            {session.abstract}
          </p>
        </div>
      )}

      {facts.length > 0 && (
        <dl className="grid gap-x-6 gap-y-2 border-b border-line-soft p-4 text-[13px] sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="w-16 shrink-0 text-dim">{label}</dt>
              <dd className="text-strong">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {session.speakers.length > 0 && (
        <div className="p-4">
          <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-dim">
            {session.speakers.length === 1 ? "Speaker" : "Speakers"}
          </h3>
          <ul className="space-y-4">
            {session.speakers.map((sp) => (
              <SpeakerCard
                key={sp.id}
                sp={sp}
                href={links?.speaker(sp.id)}
                fields={fields}
              />
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/* --- 7. Speaker detail ------------------------------------------------ */

export function SpeakerDetail({
  speaker,
  sessions,
  eventZone,
  viewerZone,
  fields,
  links,
}: {
  speaker: PublicSpeaker;
  sessions: PublicSession[];
  eventZone: string;
  viewerZone: string | null;
  fields: FieldToggles;
  links?: PublicLinks;
}) {
  const role = roleOf(speaker);
  return (
    <article className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap gap-4 border-b border-line-soft p-4">
        {speaker.headshotUrl ? (
          <img
            src={speaker.headshotUrl}
            alt=""
            className="h-24 w-24 shrink-0 rounded-full object-cover ring-1 ring-line"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-muted text-[28px] font-medium text-dim"
          >
            {speaker.name.slice(0, 1) || "?"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-semibold tracking-tight text-strong">
            {speaker.name}
          </h2>
          {role && <p className="mt-0.5 text-[14px] text-dim">{role}</p>}
          <Links links={speaker.links} />
        </div>
      </div>

      {speaker.bio && (
        <div className="border-b border-line-soft p-4">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-body">
            {speaker.bio}
          </p>
        </div>
      )}

      <div className="p-4">
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-dim">
          {sessions.length === 1 ? "Session" : "Sessions"}
        </h3>
        {sessions.length === 0 ? (
          <p className="text-[13px] text-dim">
            Nothing on the programme yet.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {sessions.map((s) => (
              <li key={s.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  {fields.showTrack && <TrackTag session={s} />}
                  <span className="text-[14px] font-medium text-strong">
                    <MaybeLink
                      to={links?.session(s.ref)}
                      className="underline-offset-2 hover:underline"
                    >
                      {s.title}
                    </MaybeLink>
                  </span>
                </div>
                <div className="mt-0.5 text-[13px] text-dim">
                  {s.startsAt === null ? (
                    "Time to be confirmed"
                  ) : (
                    <>
                      {fmtDay(localDay(s.startsAt, eventZone))} ·{" "}
                      {fmtRangeIn(s.startsAt, s.endsAt, eventZone)}
                    </>
                  )}
                  {s.roomName && ` · ${s.roomName}`}
                  <EventTime
                    utcMs={s.startsAt}
                    eventZone={eventZone}
                    viewerZone={viewerZone}
                    secondaryOnly
                    className="ml-1 text-faint"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
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
