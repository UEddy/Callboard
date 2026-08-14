/* ------------------------------------------------------------------ *
 * Data for the public display layer.
 *
 * Every query here is filtered to accepted submissions. That is not a
 * default a caller can override, because the whole surface is
 * unauthenticated and a query string should never be able to widen it
 * to drafts or declines.
 * ------------------------------------------------------------------ */

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  events,
  participants,
  rooms,
  submissionParticipants,
  submissions,
  tags,
  tracks,
} from "~/db/schema";
import type { getDb } from "~/db/client";
import { dayIsoIn, partsIn, fmtTimeIn, safeZone, zoneAbbr } from "~/lib/tz";

type Db = ReturnType<typeof getDb>;

/* The five an organiser can embed. My schedule is not one of them: it is
   personal to whoever is holding the phone, so there is nothing for a
   producer to publish. */
export const VIEWS = [
  "agenda",
  "session_list",
  "schedule_itinerary",
  "speaker_list",
  "speaker_gallery",
] as const;

export type EmbeddableView = (typeof VIEWS)[number];
export type View = EmbeddableView | "my_schedule";

/* What the public switcher offers, which is the embeddable five plus the
   attendee's own list. */
export const PUBLIC_VIEWS: View[] = [...VIEWS, "my_schedule"];

export const VIEW_LABEL: Record<View, string> = {
  agenda: "Agenda grid",
  session_list: "Sessions list",
  schedule_itinerary: "Schedule itinerary",
  speaker_list: "Speakers list",
  speaker_gallery: "Speaker gallery",
  my_schedule: "My schedule",
};

/* Each view has a URL of its own. The internal keys match the embeds
   table, the slugs are what a visitor sees and what someone pastes into
   a link, so they are short and say what they are. */
export const VIEW_SLUG: Record<View, string> = {
  agenda: "agenda",
  session_list: "sessions",
  speaker_list: "speakers",
  schedule_itinerary: "schedule",
  speaker_gallery: "gallery",
  my_schedule: "my-schedule",
};

const SLUG_TO_VIEW: Record<string, View> = Object.fromEntries(
  Object.entries(VIEW_SLUG).map(([view, slug]) => [slug, view as View]),
) as Record<string, View>;

export function viewFromSlug(slug: string | undefined): View | null {
  if (!slug) return null;
  return SLUG_TO_VIEW[slug] ?? null;
}

export function isView(v: unknown): v is View {
  return typeof v === "string" && (PUBLIC_VIEWS as string[]).includes(v);
}

/* Embeddable formats only, for the saved-embed configuration. */
export function isEmbeddableView(v: unknown): v is EmbeddableView {
  return typeof v === "string" && (VIEWS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ *
 * Links between the public views and the two detail pages.
 *
 * A detail URL carries where the visitor came from, so Back returns to
 * the list they were reading, with its filters and its search intact,
 * rather than dumping them on the default view. `from` is only ever a
 * view slug, checked against the five that exist: a raw path taken from
 * a query parameter and rendered as an href is somebody else's open
 * redirect.
 * ------------------------------------------------------------------ */

export type PublicLinks = {
  session: (idOrRef: string) => string;
  speaker: (id: string) => string;
};

/* Everything except `from`, which the detail page sets for itself. Keeps
   track, day, q and embed on the link so the whole journey stays in the
   same context, embedded or not. */
function carried(search: URLSearchParams) {
  const next = new URLSearchParams(search);
  next.delete("from");
  next.delete("view");
  return next;
}

export function publicLinks(
  slug: string,
  search: URLSearchParams,
  fromView: View,
): PublicLinks {
  const build = (kind: "sessions" | "speakers", key: string) => {
    const next = carried(search);
    next.set("from", VIEW_SLUG[fromView]);
    return `/e/${slug}/${kind}/${encodeURIComponent(key)}?${next}`;
  };
  return {
    session: (idOrRef) => build("sessions", idOrRef),
    speaker: (id) => build("speakers", id),
  };
}

/* The list this journey started from, if the URL still remembers one.
   Following a session from a speaker's page keeps pointing Back at the
   speakers list rather than quietly swapping it for the sessions list,
   so Back always means the same place for as long as the visitor keeps
   clicking. */
export function originView(search: URLSearchParams, fallback: View): View {
  return viewFromSlug(search.get("from") ?? undefined) ?? fallback;
}

/* Where Back goes. An unrecognised or absent `from` falls back to the
   view that makes sense for the thing being looked at, so a link pasted
   into a chat still has a way into the programme. */
export function backLink(
  slug: string,
  search: URLSearchParams,
  fallback: View,
): { href: string; label: string } {
  const raw = search.get("from");
  const view = (raw && viewFromSlug(raw)) || fallback;
  const next = carried(search);
  const qs = next.toString();
  return {
    href: `/e/${slug}/${VIEW_SLUG[view]}${qs ? `?${qs}` : ""}`,
    label: VIEW_LABEL[view],
  };
}

/* Matched on the human-readable ref as well as the id, so a public URL
   can read /sessions/SESS-4 rather than a UUID. */
export function findSession<T extends { id: string; ref: string }>(
  sessions: T[],
  key: string,
): T | undefined {
  const wanted = key.trim().toLowerCase();
  return sessions.find(
    (s) => s.id.toLowerCase() === wanted || s.ref.toLowerCase() === wanted,
  );
}

export type FieldToggles = {
  showRoom: boolean;
  showTrack: boolean;
  showSpeakers: boolean;
  showLevel: boolean;
  showFormat: boolean;
  showAbstract: boolean;
  showCompany: boolean;
  showBio: boolean;
  showLinks: boolean;
};

export const DEFAULT_FIELDS: FieldToggles = {
  showRoom: true,
  showTrack: true,
  showSpeakers: true,
  showLevel: false,
  showFormat: true,
  /* On by default. A programme without descriptions is a list of titles,
     and a visitor deciding how to spend their afternoon needs the
     paragraph. The lists clamp it to three lines with a toggle, so it
     costs no scanning speed. An embed that has explicitly turned it off
     keeps its own setting. */
  showAbstract: true,
  showCompany: true,
  showBio: false,
  showLinks: false,
};

/* Per-parameter overrides on top of a base, so `?showAbstract=0` works
   the same way on a list and on a detail page. */
export function applyFieldParams(
  url: URL,
  base: FieldToggles,
): FieldToggles {
  const out = { ...base };
  for (const key of Object.keys(DEFAULT_FIELDS) as (keyof FieldToggles)[]) {
    const q = url.searchParams.get(key);
    if (q === "1" || q === "true") out[key] = true;
    if (q === "0" || q === "false") out[key] = false;
  }
  return out;
}

export function parseFields(raw: unknown): FieldToggles {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_FIELDS };
  for (const k of Object.keys(DEFAULT_FIELDS) as (keyof FieldToggles)[]) {
    if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return out;
}

export type PublicSession = {
  id: string;
  ref: string;
  title: string;
  abstract: string;
  format: string | null;
  level: string | null;
  trackId: string | null;
  trackName: string | null;
  trackColor: string | null;
  roomId: string | null;
  roomName: string | null;
  startsAt: number | null;
  endsAt: number | null;
  speakers: PublicSpeaker[];
};

export type PublicSpeaker = {
  id: string;
  name: string;
  company: string | null;
  jobTitle: string | null;
  bio: string;
  headshotUrl: string | null;
  links: Record<string, string>;
};

function plain(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/* The views a search box belongs on: the ones that are a list of things
   a visitor is trying to find. The agenda grid and the itinerary are
   shaped by time rather than by what is in them, so hiding rows inside
   them leaves holes in a timetable rather than a shorter list. */
export const SEARCHABLE_VIEWS: View[] = [
  "session_list",
  "speaker_list",
  "speaker_gallery",
];

export function isSearchable(view: View) {
  return SEARCHABLE_VIEWS.includes(view);
}

/* One query string, trimmed, folded, and capped. Visitors paste all
   sorts of things into a search box, and none of it should reach a
   comparison as-is. */
export function normaliseQuery(raw: string | null | undefined) {
  const q = (raw ?? "").trim().slice(0, 100);
  return { raw: q, folded: q.toLowerCase() };
}

export async function loadPublicEvent(
  db: Db,
  slug: string,
  filters: { track?: string | null; day?: string | null; q?: string | null } = {},
) {
  const event = await db.query.events.findFirst({
    where: eq(events.slug, slug),
  });
  if (!event) return null;

  const [trackList, roomList, tagList] = await Promise.all([
    db
      .select({ id: tracks.id, name: tracks.name, color: tracks.color })
      .from(tracks)
      .where(eq(tracks.eventId, event.id))
      .orderBy(asc(tracks.sortOrder)),
    db
      .select({ id: rooms.id, name: rooms.name, capacity: rooms.capacity })
      .from(rooms)
      .where(eq(rooms.eventId, event.id))
      .orderBy(asc(rooms.sortOrder)),
    db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .where(eq(tags.eventId, event.id)),
  ]);

  const rows = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      description: submissions.description,
      format: submissions.format,
      level: submissions.level,
      trackId: submissions.trackId,
      roomId: submissions.roomId,
      startsAt: submissions.startsAt,
      endsAt: submissions.endsAt,
      isDraftSchedule: submissions.isDraftSchedule,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.eventId, event.id),
        // Not negotiable, and not derived from any input.
        eq(submissions.status, "accepted"),
      ),
    )
    .orderBy(asc(submissions.startsAt));

  const ids = rows.map((r) => r.id);
  const people = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          sortOrder: submissionParticipants.sortOrder,
          id: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
          company: participants.company,
          jobTitle: participants.jobTitle,
          bio: participants.bio,
          headshotUrl: participants.headshotUrl,
          links: participants.links,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
    : [];

  const trackById = new Map(trackList.map((t) => [t.id, t]));
  const roomById = new Map(roomList.map((r) => [r.id, r]));

  let sessions: PublicSession[] = rows.map((r) => {
    const track = r.trackId ? trackById.get(r.trackId) : undefined;
    /* A draft slot is a producer thinking out loud on the agenda
       builder, so the public sees the session without a time or a room
       until the schedule is published. The views already render that as
       "time to be confirmed", which is the truth. */
    const room = r.roomId && !r.isDraftSchedule ? roomById.get(r.roomId) : undefined;
    const startsAt = r.isDraftSchedule ? null : r.startsAt;
    const endsAt = r.isDraftSchedule ? null : r.endsAt;
    return {
      id: r.id,
      ref: r.ref,
      title: r.title,
      abstract: plain(r.description),
      format: r.format,
      level: r.level,
      trackId: r.trackId,
      trackName: track?.name ?? null,
      trackColor: track?.color ?? null,
      roomId: r.isDraftSchedule ? null : r.roomId,
      roomName: room?.name ?? null,
      startsAt: startsAt ? new Date(startsAt).getTime() : null,
      endsAt: endsAt ? new Date(endsAt).getTime() : null,
      speakers: people
        .filter((p) => p.submissionId === r.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => ({
          id: p.id,
          name: [p.firstName, p.lastName].filter(Boolean).join(" "),
          company: p.company,
          jobTitle: p.jobTitle,
          bio: plain(p.bio),
          headshotUrl: p.headshotUrl,
          links: (p.links ?? {}) as Record<string, string>,
        })),
    };
  });

  if (filters.track) {
    sessions = sessions.filter(
      (s) =>
        s.trackId === filters.track ||
        s.trackName?.toLowerCase() === filters.track!.toLowerCase(),
    );
  }

  const zone = safeZone(event.timezone);
  const days = [
    ...new Set(
      sessions
        .filter((s) => s.startsAt !== null)
        .map((s) => localDay(s.startsAt!, zone)),
    ),
  ].sort();

  if (filters.day) {
    sessions = sessions.filter(
      (s) => s.startsAt !== null && localDay(s.startsAt, zone) === filters.day,
    );
  }

  /* Search runs last, and after the day list is built, so typing does not
     make the day options disappear from under the cursor.

     One query serves both kinds of view: a session is in scope when its
     title matches or anybody on it matches, which is what makes
     searching a speaker's name find their talk. The speaker list is then
     narrowed again, to the people who matched by name plus everybody on
     a session that matched by title, so searching a name returns that
     person rather than them and all their co-presenters. */
  const { raw: queryRaw, folded: query } = normaliseQuery(filters.q);
  let titleMatchedIds = new Set<string>();

  if (query) {
    const nameHits = (s: PublicSession) =>
      s.speakers.some((p) => p.name.toLowerCase().includes(query));
    const titleHits = (s: PublicSession) => s.title.toLowerCase().includes(query);

    titleMatchedIds = new Set(sessions.filter(titleHits).map((s) => s.id));
    sessions = sessions.filter((s) => titleHits(s) || nameHits(s));
  }

  // Speakers, deduplicated, with the sessions they are on.
  const speakerMap = new Map<
    string,
    PublicSpeaker & { sessions: { ref: string; title: string }[] }
  >();
  /* Who the query itself reached: matched by their own name, or carried
     in by a session whose title matched. */
  const speakerHit = new Set<string>();

  for (const s of sessions) {
    for (const sp of s.speakers) {
      const existing = speakerMap.get(sp.id);
      if (existing) existing.sessions.push({ ref: s.ref, title: s.title });
      else
        speakerMap.set(sp.id, {
          ...sp,
          sessions: [{ ref: s.ref, title: s.title }],
        });

      if (
        query &&
        (titleMatchedIds.has(s.id) || sp.name.toLowerCase().includes(query))
      ) {
        speakerHit.add(sp.id);
      }
    }
  }

  let speakers = [...speakerMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (query) speakers = speakers.filter((sp) => speakerHit.has(sp.id));

  return {
    event: {
      id: event.id,
      slug: event.slug,
      name: event.name,
      description: event.description,
      startsAt: event.startsAt ? new Date(event.startsAt).getTime() : null,
      endsAt: event.endsAt ? new Date(event.endsAt).getTime() : null,
      timezone: zone,
    },
    tracks: trackList,
    rooms: roomList,
    tags: tagList,
    sessions,
    speakers,
    days,
    query: queryRaw,
  };
}

/* Display helpers now take the event zone explicitly, so the public
   grid and the admin grid put a session in the same slot because they
   are reading the same stored zone rather than sharing a guess. */
export function localDay(ms: number, timeZone: string) {
  return dayIsoIn(ms, timeZone);
}

export function localParts(ms: number, timeZone: string) {
  const p = partsIn(ms, timeZone);
  return { hour: p.hour, minute: p.minute };
}

export function fmtTime(ms: number | null, timeZone: string) {
  if (ms === null) return "Time to be confirmed";
  return fmtTimeIn(ms, timeZone);
}

/* "10:00 AM to 11:30 AM PDT", in the event's own clock, with the zone
   named so a reader in another country knows which clock it is. */
export function fmtRangeIn(
  startMs: number | null,
  endMs: number | null,
  timeZone: string,
) {
  if (startMs === null) return "Time to be confirmed";
  const start = fmtTimeIn(startMs, timeZone);
  const abbr = zoneAbbr(startMs, timeZone);
  if (endMs === null) return `${start} ${abbr}`;
  return `${start} to ${fmtTimeIn(endMs, timeZone)} ${abbr}`;
}

export function fmtDay(dayIso: string) {
  return new Date(`${dayIso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
