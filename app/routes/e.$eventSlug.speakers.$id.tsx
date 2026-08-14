import { useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { getDb } from "~/db/client";
import {
  DEFAULT_FIELDS,
  applyFieldParams,
  backLink,
  loadPublicEvent,
  originView,
  publicLinks,
} from "~/lib/public-event";
import { PublicDetailPage, SpeakerDetail } from "~/components/PublicViews";
import { readViewerZone } from "~/lib/viewer-tz";

/* ------------------------------------------------------------------ *
 * One speaker, in public.
 *
 * /e/:eventSlug/speakers/:id, reachable from the speakers list, a
 * gallery card, and from the speaker panel on any session. Their
 * sessions come from the same accepted-only load as the lists, so a
 * speaker page can never surface a session the programme does not show.
 * ------------------------------------------------------------------ */

export { headers } from "./e.$eventSlug";

export async function loader({ context, params, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);

  const loaded = await loadPublicEvent(db, params.eventSlug!);
  if (!loaded) throw new Response("Event not found", { status: 404 });

  const speaker = loaded.speakers.find((s) => s.id === params.id);
  if (!speaker) throw new Response("Speaker not found", { status: 404 });

  const theirs = loaded.sessions
    .filter((s) => s.speakers.some((p) => p.id === speaker.id))
    .sort((a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity));

  return {
    event: loaded.event,
    speaker,
    sessions: theirs,
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
  if (!loaderData) return [{ title: "Speaker" }];
  const { speaker, event } = loaderData;
  const role = [speaker.jobTitle, speaker.company].filter(Boolean).join(", ");
  return [
    { title: `${speaker.name} · ${event.name}` },
    {
      name: "description",
      content:
        speaker.bio.slice(0, 160) ||
        [speaker.name, role].filter(Boolean).join(", "),
    },
  ];
}

export default function PublicSpeakerDetail() {
  const { event, speaker, sessions, fields, embed, eventZone, viewerZone, ms } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  // Their sessions keep Back pointing wherever the journey began.
  const from = originView(params, "session_list");
  const links = publicLinks(event.slug, params, from);

  return (
    <PublicDetailPage
      eventName={event.name}
      eventSlug={event.slug}
      back={backLink(event.slug, params, "speaker_list")}
      embed={embed}
      ms={ms}
    >
      <SpeakerDetail
        speaker={speaker}
        sessions={sessions}
        eventZone={eventZone}
        viewerZone={viewerZone}
        fields={fields}
        links={links}
      />
    </PublicDetailPage>
  );
}
