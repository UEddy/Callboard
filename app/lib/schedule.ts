/* ------------------------------------------------------------------ *
 * Scheduling maths and conflict detection.
 *
 * Extracted from the agenda builder so the dashboard can count conflicts
 * with the same code that renders them. A dashboard that says "2
 * conflicts" while the agenda shows 3 is worse than no dashboard: the
 * producer stops believing either number.
 * ------------------------------------------------------------------ */

/* The event runs in America/Los_Angeles, which is PDT (UTC-7) across all
   three days in October 2026. A fixed offset keeps the grid honest
   without pulling in a timezone library. */
export const EVENT_UTC_OFFSET = -7;
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 18;
export const SLOT_MINUTES = 30;

export const DURATION_BY_FORMAT: Record<string, number> = {
  Keynote: 45,
  "Talk (25 min)": 25,
  "Workshop (90 min)": 90,
  "Lightning Talk (10 min)": 10,
};

export function durationFor(format: string | null) {
  return (format && DURATION_BY_FORMAT[format]) || 30;
}

export function slotToUtcMs(dayIso: string, hour: number, minute: number) {
  const [y, m, d] = dayIso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - EVENT_UTC_OFFSET, minute);
}

export function utcMsToLocalParts(ms: number) {
  const shifted = new Date(ms + EVENT_UTC_OFFSET * 3_600_000);
  return {
    dayIso: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
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
    const start = utcMsToLocalParts(s.startMs);
    const end = utcMsToLocalParts(s.endMs);
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

/* The days the event spans, as local ISO dates. */
export function eventDays(
  startsAt: Date | number | null,
  endsAt: Date | number | null,
): string[] {
  if (!startsAt || !endsAt) return [];
  const out: string[] = [];
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  for (
    let d = new Date(start);
    d.getTime() <= end.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
