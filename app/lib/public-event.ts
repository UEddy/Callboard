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
import { dayIsoIn, partsIn, fmtTimeIn, safeZone } from "~/lib/tz";

type Db = ReturnType<typeof getDb>;

export const VIEWS = [
  "agenda",
  "session_list",
  "schedule_itinerary",
  "speaker_list",
  "speaker_gallery",
] as const;

export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<View, string> = {
  agenda: "Agenda grid",
  session_list: "Sessions list",
  schedule_itinerary: "Schedule itinerary",
  speaker_list: "Speakers list",
  speaker_gallery: "Speaker gallery",
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
};

const SLUG_TO_VIEW: Record<string, View> = Object.fromEntries(
  Object.entries(VIEW_SLUG).map(([view, slug]) => [slug, view as View]),
) as Record<string, View>;

export function viewFromSlug(slug: string | undefined): View | null {
  if (!slug) return null;
  return SLUG_TO_VIEW[slug] ?? null;
}

export function isView(v: unknown): v is View {
  return typeof v === "string" && (VIEWS as readonly string[]).includes(v);
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
  showAbstract: false,
  showCompany: true,
  showBio: false,
  showLinks: false,
};

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

export async function loadPublicEvent(
  db: Db,
  slug: string,
  filters: { track?: string | null; day?: string | null } = {},
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
    const room = r.roomId ? roomById.get(r.roomId) : undefined;
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
      roomId: r.roomId,
      roomName: room?.name ?? null,
      startsAt: r.startsAt ? new Date(r.startsAt).getTime() : null,
      endsAt: r.endsAt ? new Date(r.endsAt).getTime() : null,
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

  // Speakers, deduplicated, with the sessions they are on.
  const speakerMap = new Map<
    string,
    PublicSpeaker & { sessions: { ref: string; title: string }[] }
  >();
  for (const s of sessions) {
    for (const sp of s.speakers) {
      const existing = speakerMap.get(sp.id);
      if (existing) existing.sessions.push({ ref: s.ref, title: s.title });
      else
        speakerMap.set(sp.id, {
          ...sp,
          sessions: [{ ref: s.ref, title: s.title }],
        });
    }
  }
  const speakers = [...speakerMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

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

export function fmtDay(dayIso: string) {
  return new Date(`${dayIso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
