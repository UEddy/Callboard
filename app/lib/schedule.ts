/* ------------------------------------------------------------------ *
 * Scheduling maths and conflict detection.
 *
 * Extracted from the agenda builder so the dashboard can count conflicts
 * with the same code that renders them. A dashboard that says "2
 * conflicts" while the agenda shows 3 is worse than no dashboard: the
 * producer stops believing either number.
 * ------------------------------------------------------------------ */

import { dayIsoToUtc, partsIn, dayIsoIn } from "./tz";

export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 18;
export const SLOT_MINUTES = 30;

export const DEFAULT_DURATION_MINUTES = 30;

/* Formats are free text an organiser types, so the length has to be read
   out of the string rather than looked up in a table. A table only knows
   the seed's four spellings, and every format anybody else invents would
   silently become 30 minutes and be laid out wrong on the grid.
   Handles "Talk (30 min)", "Workshop (120 min)", "Keynote - 1 hour",
   "Panel (1.5 hours)", "Lightning (10m)". */
const DURATION_PATTERN =
  /(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m)\b/i;

/* Names with a conventional length and no number in them. Only a
   fallback: a "Keynote (60 min)" is sixty minutes, not forty-five. */
const DURATION_BY_NAME: { match: RegExp; minutes: number }[] = [
  { match: /keynote/i, minutes: 45 },
  { match: /lightning/i, minutes: 10 },
  { match: /workshop/i, minutes: 90 },
  { match: /panel/i, minutes: 45 },
];

export type DurationSource = "parsed" | "name" | "default";

/* The length and where it came from, so the UI can show a producer what
   was assumed rather than laying out a session on a number nobody
   chose. */
export function durationDetail(format: string | null): {
  minutes: number;
  source: DurationSource;
} {
  const raw = (format ?? "").trim();
  if (raw) {
    const m = raw.match(DURATION_PATTERN);
    if (m) {
      const value = Number(m[1]);
      const unit = m[2].toLowerCase();
      const isHours = unit.startsWith("h");
      const minutes = Math.round(isHours ? value * 60 : value);
      // A zero or a silly number is worse than the default: it would
      // render as a session with no height, or one covering the week.
      if (minutes > 0 && minutes <= 24 * 60) {
        return { minutes, source: "parsed" };
      }
    }
    for (const known of DURATION_BY_NAME) {
      if (known.match.test(raw)) {
        return { minutes: known.minutes, source: "name" };
      }
    }
  }
  return { minutes: DEFAULT_DURATION_MINUTES, source: "default" };
}

export function durationFor(format: string | null) {
  return durationDetail(format).minutes;
}

/* "90 min" when the format said so, "45 min, assumed" when Callboard
   picked it. The qualifier is the point: a producer seeing a session
   sized wrong needs to know the length was a guess from the format
   string, not something they set. */
export function durationLabel(format: string | null) {
  const d = durationDetail(format);
  return d.source === "parsed"
    ? `${d.minutes} min`
    : `${d.minutes} min, assumed`;
}

export function slotToUtcMs(
  dayIso: string,
  hour: number,
  minute: number,
  timeZone: string,
) {
  return dayIsoToUtc(dayIso, hour, minute, timeZone);
}

export function utcMsToLocalParts(ms: number, timeZone: string) {
  const p = partsIn(ms, timeZone);
  return { dayIso: dayIsoIn(ms, timeZone), hour: p.hour, minute: p.minute };
}

export function fmtTime(hour: number, minute: number) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const ap = hour < 12 ? "AM" : "PM";
  return `${h}:${String(minute).padStart(2, "0")} ${ap}`;
}

export type Scheduled = {
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
  /* Placed but not published. The builder sets it; the screens that only
     count conflicts have no use for it. */
  isDraft?: boolean;
  speakers: { id: string; name: string }[];
};

export type Conflict = {
  kind: "room" | "speaker" | "hours" | "track";
  message: string;
  submissionIds: string[];
};

export function detectConflicts(
  list: Scheduled[],
  dayIsos: string[],
  timeZone: string,
): Conflict[] {
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
    const start = utcMsToLocalParts(s.startMs, timeZone);
    const end = utcMsToLocalParts(s.endMs, timeZone);
    const outsideDay = !dayIsos.includes(start.dayIso);
    const tooEarly = start.hour < DAY_START_HOUR;
    const tooLate =
      end.hour > DAY_END_HOUR || (end.hour === DAY_END_HOUR && end.minute > 0);
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

/* Which calendar day an event boundary names.
 *
 * These two columns carry two different kinds of value. Set through
 * Settings they are a real instant in the event's zone, and the day is
 * the day in that zone. Seeded, imported, or written by anything with a
 * date-only picker they are midnight UTC, which is a calendar date
 * wearing an instant's clothes: read as an instant west of Greenwich it
 * lands on the evening before, and the whole grid slides a day.
 *
 * Exactly midnight UTC is therefore read as the date it spells out.
 * The one case it gets wrong is an event genuinely starting at midnight
 * UTC to the second, which is 5pm the previous day in California and not
 * a time any conference starts. */
function boundaryDayIso(value: Date | number, timeZone: string): string {
  const ms = new Date(value).getTime();
  const d = new Date(ms);
  const isDateOnly =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  if (!isDateOnly) return dayIsoIn(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/* The days the event spans, as ISO dates in the event's own zone.
 *
 * `alsoInclude` takes the days things are actually scheduled on, so the
 * builder cannot end up with a session on a day it offers no tab for,
 * and so it lands on the same days as the public agenda, which derives
 * its list from the sessions. Two screens disagreeing about which day is
 * Day 1 is the same class of bug as two screens disagreeing about the
 * conflict count. */
export function eventDays(
  startsAt: Date | number | null,
  endsAt: Date | number | null,
  timeZone: string,
  alsoInclude: string[] = [],
): string[] {
  const out = new Set<string>(alsoInclude);

  if (startsAt && endsAt) {
    const endDay = boundaryDayIso(endsAt, timeZone);
    let day = boundaryDayIso(startsAt, timeZone);
    // Step a day at a time in the zone, so a DST day of 23 or 25 hours
    // still produces exactly one calendar entry.
    for (let guard = 0; guard < 400; guard++) {
      out.add(day);
      if (day >= endDay) break;
      day = dayIsoIn(
        dayIsoToUtc(day, 12, 0, timeZone) + 24 * 3_600_000,
        timeZone,
      );
    }
  }

  return [...out].sort();
}
