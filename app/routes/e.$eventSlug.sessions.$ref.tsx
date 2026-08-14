import { useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { getDb } from "~/db/client";
import {
  DEFAULT_FIELDS,
  applyFieldParams,
  backLink,
  findSession,
  loadPublicEvent,
  originView,
  publicLinks,
} from "~/lib/public-event";
import {
  PublicDetailPage,
  SessionDetail,
  StarButton,
  useStarred,
} from "~/components/PublicViews";
import { readViewerZone } from "~/lib/viewer-tz";

/* ------------------------------------------------------------------ *
 * One session, in public.
 *
 * /e/:eventSlug/sessions/SESS-4, reachable from an agenda block, a card
 * on the sessions list, a row on the itinerary, and from any speaker's
 * page. The ref is in the URL rather than the id because this is a link
 * people paste into chat.
 *
 * Loaded through the same loadPublicEvent as every list, with no
 * filters: a session reached from a filtered list must still open, and
 * the speaker panel needs the same accepted-only guarantee the lists
 * have rather than a second query with its own idea of what is public.
 * ------------------------------------------------------------------ */

export { headers } from "./e.$eventSlug";

export async function loader({ context, params, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);

  const loaded = await loadPublicEvent(db, params.eventSlug!);
  if (!loaded) throw new Response("Event not found", { status: 404 });

  const session = findSession(loaded.sessions, params.ref ?? "");
  if (!session) throw new Response("Session not found", { status: 404 });

  return {
    event: loaded.event,
    session,
    fields: applyFieldParams(url, DEFAULT_FIELDS),
    embed:
      url.searchParams.get("embed") === "1" ||
      url.searchParams.get("embed") === "true",
    eventZone: loaded.event.timezone,
    viewerZone: await readViewerZone(request),
    ms: Date.now() - started,
  };
}

export function meta({ loaderData }: MetaArgs<typeof loader>) {
  if (!loaderData) return [{ title: "Session" }];
  const { session, event } = loaderData;
  return [
    { title: `${session.title} · ${event.name}` },
    {
      name: "description",
      content:
        session.abstract.slice(0, 160) ||
        `${session.title} at ${event.name}.`,
    },
  ];
}

export default function PublicSessionDetail() {
  const { event, session, fields, embed, eventZone, viewerZone, ms } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const stars = useStarred(event.slug);

  /* Whatever list the visitor started from stays the destination of
     Back, all the way down the chain. Absent one, a speaker's name
     belongs to the speakers list. */
  const from = originView(params, "speaker_list");
  const links = publicLinks(event.slug, params, from);

  return (
    <PublicDetailPage
      eventName={event.name}
      eventSlug={event.slug}
      back={backLink(event.slug, params, "session_list")}
      embed={embed}
      ms={ms}
    >
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-[13px] text-body">
          <StarButton
            session={session}
            starred={stars.isStarred(session.ref)}
            ready={stars.ready}
            onToggle={stars.toggle}
          />
          {stars.ready && stars.isStarred(session.ref)
            ? "In my schedule"
            : "Add to my schedule"}
        </span>
        {session.startsAt !== null && (
          <a
            href={`/e/${event.slug}/calendar.ics?s=${encodeURIComponent(session.ref)}`}
            className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[13px] font-medium text-body hover:bg-subtle"
          >
            Add to calendar
          </a>
        )}
      </div>

      <SessionDetail
        session={session}
        eventZone={eventZone}
        viewerZone={viewerZone}
        fields={fields}
        links={links}
      />
    </PublicDetailPage>
  );
}
