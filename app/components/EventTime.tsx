import { useEffect, useState } from "react";
import { dualTime } from "~/lib/tz";

/* ------------------------------------------------------------------ *
 * An instant, shown in the event's timezone.
 *
 * The event's own time is the primary reading, always, because that is
 * what the room and the printed programme say. The viewer's equivalent
 * is secondary and only appears when it actually differs.
 *
 * Server rendered from the cookie. On a first visit the cookie does not
 * exist yet, so the secondary reading is filled in after mount from the
 * browser's own zone. The initial client render deliberately matches the
 * server to avoid a hydration mismatch, then updates.
 * ------------------------------------------------------------------ */

export function EventTime({
  utcMs,
  eventZone,
  viewerZone,
  className,
  secondaryClassName,
  /* Render only the viewer's reading, and nothing at all when it matches
     the event's. For places that already state the event's time in full,
     like a session's start-to-end range, where repeating it would read
     as two different times. */
  secondaryOnly = false,
}: {
  utcMs: number | null;
  eventZone: string;
  viewerZone: string | null;
  className?: string;
  secondaryClassName?: string;
  secondaryOnly?: boolean;
}) {
  const [zone, setZone] = useState<string | null>(viewerZone);

  useEffect(() => {
    if (viewerZone) return;
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected) setZone(detected);
    } catch {
      /* leave it out rather than guess */
    }
  }, [viewerZone]);

  if (utcMs === null) {
    if (secondaryOnly) return null;
    return <span className={className}>Time to be confirmed</span>;
  }

  const t = dualTime(utcMs, eventZone, zone);

  if (secondaryOnly) {
    if (!t.secondary) return null;
    /* Parenthesised so it reads correctly after whatever precedes it,
       without the caller having to add a separator that would be left
       dangling when the zones match and this renders nothing. */
    return <span className={className}>({t.secondary} your time)</span>;
  }

  return (
    <span className={className}>
      {t.primary} <span className="tabular-nums">{t.abbr}</span>
      {t.secondary && (
        <span className={secondaryClassName ?? "text-dim"}>
          {" "}
          ({t.secondary} your time)
        </span>
      )}
    </span>
  );
}

/* Writes the browser's zone into a cookie so the next server render can
   include the secondary reading. No fetch, no revalidation: the same
   reasoning as the theme switch. */
export function ViewerZoneProbe({ current }: { current: string | null }) {
  useEffect(() => {
    let detected: string | null = null;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return;
    }
    if (!detected || detected === current) return;
    document.cookie = `cb_tz=${encodeURIComponent(
      btoa(JSON.stringify(detected)),
    )}; Path=/; Max-Age=${60 * 60 * 24 * 180}; SameSite=Lax`;
  }, [current]);

  return null;
}
