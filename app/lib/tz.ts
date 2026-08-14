/* ------------------------------------------------------------------ *
 * Timezones, for real this time.
 *
 * This replaces a hardcoded EVENT_UTC_OFFSET = -7 that was scattered
 * across seven files. That constant was correct for one event in one
 * October and silently wrong for everything else, including the same
 * event either side of a daylight saving change.
 *
 * Everything here works from the event's stored IANA zone through Intl,
 * so the answer is right for any zone and any date. Instants are always
 * stored and passed around as UTC milliseconds; a zone is only ever
 * applied at the moment something is displayed or a wall clock time is
 * converted into an instant.
 * ------------------------------------------------------------------ */

export const FALLBACK_ZONE = "UTC";

export type ZonedParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export function isValidZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function safeZone(zone: string | null | undefined) {
  return isValidZone(zone) ? zone : FALLBACK_ZONE;
}

/* The wall clock reading in `timeZone` at a given instant. */
export function partsIn(utcMs: number, timeZone: string): ZonedParts {
  const tz = safeZone(timeZone);
  const map: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl renders midnight as 24 in hour12:false for some locales.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second ?? 0),
  };
}

/* Offset of `timeZone` from UTC at a given instant, in milliseconds.
   Positive east of Greenwich. Derived rather than tabulated, so DST is
   handled by the platform's own zone database. */
export function offsetAt(utcMs: number, timeZone: string): number {
  const p = partsIn(utcMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - utcMs;
}

/* A wall clock time in `timeZone` back to a UTC instant.
   Two passes: the offset itself depends on the instant we are solving
   for, so the first guess is corrected once, which is enough for every
   real zone transition. */
export function wallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetAt(guess, timeZone);
  let ms = guess - first;
  const second = offsetAt(ms, timeZone);
  if (second !== first) ms = guess - second;
  return ms;
}

export function dayIsoToUtc(
  dayIso: string,
  hour: number,
  minute: number,
  timeZone: string,
) {
  const [y, m, d] = dayIso.split("-").map(Number);
  return wallToUtc(y, m, d, hour, minute, timeZone);
}

/* --- datetime-local, in the event's zone ---------------------------- *
 *
 * A datetime-local input has no timezone: it is a wall clock reading,
 * and whoever reads it decides which clock. Left to the browser's own
 * getters it means the producer's clock, so a deadline typed by someone
 * in Berlin for a conference in California lands nine hours out and
 * nobody notices until the form closes early. Every screen that edits an
 * instant goes through these two, against the event's zone, and says so
 * next to the field.
 */
export function toZonedInput(ms: number | null, timeZone: string) {
  if (ms === null) return "";
  const p = partsIn(ms, safeZone(timeZone));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function fromZonedInput(value: string, timeZone: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(
    wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], safeZone(timeZone)),
  );
}

/* Local calendar date in the zone, as YYYY-MM-DD. */
export function dayIsoIn(utcMs: number, timeZone: string) {
  const p = partsIn(utcMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/* "PDT", "GMT+1", "JST". Whatever the platform calls the zone at that
   moment, which is the label a reader recognises. */
export function zoneAbbr(utcMs: number, timeZone: string): string {
  const tz = safeZone(timeZone);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
      hour: "numeric",
    }).formatToParts(new Date(utcMs));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

export function fmtTimeIn(utcMs: number, timeZone: string) {
  const { hour, minute } = partsIn(utcMs, timeZone);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function fmtDateIn(
  utcMs: number,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
  },
) {
  return new Intl.DateTimeFormat("en-US", {
    ...opts,
    timeZone: safeZone(timeZone),
  }).format(new Date(utcMs));
}

/* --- Dual display -------------------------------------------------- */

/* The event's own time is always the primary reading, because that is
   what the room, the badge and the printed programme say. The viewer's
   local equivalent is secondary and only shown when it differs, since
   "(9:00 AM your time)" next to "9:00 AM PDT" is noise. */
export function sameWallClock(
  utcMs: number,
  a: string,
  b: string,
): boolean {
  if (safeZone(a) === safeZone(b)) return true;
  return offsetAt(utcMs, safeZone(a)) === offsetAt(utcMs, safeZone(b));
}

export type DualTime = {
  primary: string;
  abbr: string;
  secondary: string | null;
};

export function dualTime(
  utcMs: number,
  eventZone: string,
  viewerZone: string | null | undefined,
): DualTime {
  const ez = safeZone(eventZone);
  const primary = fmtTimeIn(utcMs, ez);
  const abbr = zoneAbbr(utcMs, ez);

  if (!isValidZone(viewerZone) || sameWallClock(utcMs, ez, viewerZone)) {
    return { primary, abbr, secondary: null };
  }
  return { primary, abbr, secondary: fmtTimeIn(utcMs, viewerZone) };
}

/* "9:00 AM PDT (5:00 PM your time)" as one string, for places that
   cannot render a component: emails, the API, plain text. */
export function dualTimeText(
  utcMs: number,
  eventZone: string,
  viewerZone?: string | null,
) {
  const d = dualTime(utcMs, eventZone, viewerZone);
  return d.secondary
    ? `${d.primary} ${d.abbr} (${d.secondary} your time)`
    : `${d.primary} ${d.abbr}`;
}

/* Full "Monday, October 12 at 9:00 AM PDT" for emails and summaries. */
export function fmtWhenIn(
  utcMs: number | null,
  eventZone: string,
  viewerZone?: string | null,
) {
  if (utcMs === null) return "to be confirmed";
  return `${fmtDateIn(utcMs, eventZone)} at ${dualTimeText(utcMs, eventZone, viewerZone)}`;
}

/* --- The picker ----------------------------------------------------- */

/* Straight from the platform's zone database, so it cannot go stale the
   way a checked in list does. */
export function allZones(): string[] {
  try {
    const fn = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf;
    if (typeof fn === "function") return fn("timeZone");
  } catch {
    /* fall through */
  }
  return [
    "UTC",
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Madrid",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Australia/Sydney",
  ];
}

/* "America/Los_Angeles (PDT, UTC-7)" so a producer can pick without
   knowing the IANA naming scheme. */
export function describeZone(zone: string, at = Date.now()) {
  const off = offsetAt(at, zone) / 60_000;
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  const offset = `UTC${sign}${hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
  return `${zone.replace(/_/g, " ")} (${zoneAbbr(at, zone)}, ${offset})`;
}
