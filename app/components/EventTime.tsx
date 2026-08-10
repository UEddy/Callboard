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
}: {
  utcMs: number | null;
  eventZone: string;
  viewerZone: string | null;
  className?: string;
  secondaryClassName?: string;
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
    return <span className={className}>Time to be confirmed</span>;
  }

  const t = dualTime(utcMs, eventZone, zone);

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
