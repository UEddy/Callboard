import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "~/db/client";
import { findSession, loadPublicEvent } from "~/lib/public-event";
import { buildIcsCalendar, type CalendarEvent } from "~/lib/email";
import { durationFor } from "~/lib/schedule";
import { fmtDateIn, fmtTimeIn, zoneAbbr } from "~/lib/tz";

/* ------------------------------------------------------------------ *
 * Calendar downloads for attendees.
 *
 * /e/:eventSlug/calendar.ics?s=SESS-4              one session
 * /e/:eventSlug/calendar.ics?s=SESS-1&s=SESS-4     a personal schedule
 *
 * The refs come from the URL because that is where a personal schedule
 * can live without an account: the stars are in the browser's storage,
 * and the download is an ordinary link built from them. Nothing is
 * stored, nothing is tracked, and it works inside an iframe.
 *
 * Read through loadPublicEvent, so this cannot export anything the
 * public programme does not already show: accepted only, and a session
 * whose schedule is still a draft has no time to export.
 * ------------------------------------------------------------------ */

const MAX_EVENTS = 100;

export async function loader({ context, params, request }: LoaderFunctionArgs) {
  const db = getDb(context);
  const url = new URL(request.url);

  const wanted = url.searchParams.getAll("s").filter(Boolean).slice(0, MAX_EVENTS);
  if (wanted.length === 0) {
    throw new Response("Ask for at least one session, as ?s=SESS-1", {
      status: 400,
    });
  }

  const loaded = await loadPublicEvent(db, params.eventSlug!);
  if (!loaded) throw new Response("Event not found", { status: 404 });

  const zone = loaded.event.timezone;
  const origin = url.origin;

  const chosen = wanted
    .map((ref) => findSession(loaded.sessions, ref))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  /* A session with no published time cannot go in a calendar. Skipping
     it beats inventing a slot, and the screen that built this link
     already says those are not included. */
  const timed = chosen.filter((s) => s.startsAt !== null);

  if (timed.length === 0) {
    throw new Response(
      "None of those sessions have a published time yet.",
      { status: 404 },
    );
  }

  const events: CalendarEvent[] = timed.map((s) => {
    const start = new Date(s.startsAt!);
    const end = s.endsAt
      ? new Date(s.endsAt)
      : new Date(s.startsAt! + durationFor(s.format) * 60_000);

    /* Room and track go in the description as well as LOCATION, because
       a phone's notification shows the description and an attendee
       standing in a corridor wants the room. The event's own local time
       is repeated for anyone reading the file rather than importing it:
       the DTSTART itself is a UTC instant, which every client renders in
       the reader's own zone. */
    const localTime = `${fmtDateIn(s.startsAt!, zone, {
      weekday: "long",
      month: "long",
      day: "numeric",
    })}, ${fmtTimeIn(s.startsAt!, zone)} ${zoneAbbr(s.startsAt!, zone)}`;

    const description = [
      s.abstract || null,
      `Time: ${localTime}`,
      s.roomName ? `Room: ${s.roomName}` : null,
      s.trackName ? `Track: ${s.trackName}` : null,
      s.speakers.length
        ? `Speakers: ${s.speakers.map((p) => p.name).join(", ")}`
        : null,
      `${origin}/e/${loaded.event.slug}/sessions/${s.ref}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      /* Stable per session and per event, so re-importing updates the
         entry a visitor already has rather than adding a second one. */
      uid: `${s.id}@${loaded.event.slug}.callboard`,
      start,
      end,
      title: s.title,
      description,
      location: s.roomName ?? undefined,
      url: `${origin}/e/${loaded.event.slug}/sessions/${s.ref}`,
    };
  });

  const single = events.length === 1;
  const body = buildIcsCalendar(
    events,
    single ? timed[0].title : `${loaded.event.name}: my schedule`,
  );

  const filename = single
    ? `${loaded.event.slug}-${timed[0].ref.toLowerCase()}.ics`
    : `${loaded.event.slug}-my-schedule.ics`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Built from the visitor's own list, so it is theirs alone and
      // must never sit in a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
