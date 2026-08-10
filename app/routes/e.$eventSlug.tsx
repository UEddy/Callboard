import { data, Link, useLoaderData, useSearchParams } from "react-router";
import type {
  LoaderFunctionArgs,
  HeadersFunction,
  MetaArgs,
} from "react-router";
import { getDb } from "~/db/client";
import {
  DEFAULT_FIELDS,
  isView,
  loadPublicEvent,
  parseFields,
  VIEWS,
  VIEW_LABEL,
  VIEW_SLUG,
  viewFromSlug,
  type View,
} from "~/lib/public-event";
import { renderView } from "~/components/PublicViews";
import { embeds } from "~/db/schema";
import { eq } from "drizzle-orm";
import { readViewerZone } from "~/lib/viewer-tz";

/* ------------------------------------------------------------------ *
 * The public display layer.
 *
 * /e/:eventSlug                 standalone page with a view switcher
 * /e/:eventSlug?embed=1         bare fragment for an iframe, no chrome
 * /e/:eventSlug?token=pub_...   an embed's saved configuration
 *
 * Everything here is anonymous and accepted-only, which is what makes it
 * safe to cache hard at the edge. Nothing on this route reads a cookie,
 * so no response varies by visitor.
 * ------------------------------------------------------------------ */

const CACHE_SECONDS = 300;
const STALE_SECONDS = 3600;

/* The loader sets Cache-Control for the cases that need a different one
   (a retired embed gets a short cache so re-enabling it takes effect
   quickly). HeadersArgs does not carry loaderData, so the loader has to
   communicate through its own headers rather than the header function
   inspecting the payload. */
export const headers: HeadersFunction = ({ loaderHeaders }) => ({
  "Cache-Control":
    loaderHeaders.get("Cache-Control") ??
    `public, max-age=60, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
  // Embedding is the point, so framing is allowed. The trade is that this
  // route must never render anything authenticated, which is enforced by
  // it never reading a session.
  "Content-Security-Policy": "frame-ancestors *",
  Vary: "Accept-Encoding",
});

export async function loader({ context, params, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);

  // A saved embed supplies the defaults; query parameters can still
  // override them, which is what makes the admin preview work.
  let saved: {
    format: string;
    filters: Record<string, unknown>;
    fields: Record<string, unknown>;
    name: string;
  } | null = null;

  if (params.view && !viewFromSlug(params.view)) {
    throw new Response("Unknown view", { status: 404 });
  }

  const token = url.searchParams.get("token");
  let retired = false;
  if (token) {
    const row = await db.query.embeds.findFirst({
      where: eq(embeds.publicToken, token),
    });
    if (row?.enabled) {
      saved = {
        format: row.format,
        filters: (row.filters ?? {}) as Record<string, unknown>,
        fields: (row.fields ?? {}) as Record<string, unknown>,
        name: row.name,
      };
    } else {
      // Switched off or deleted. Falling through to the default view would
      // keep the programme on someone else's page after the organiser
      // believed they had taken it down, so this stops here.
      retired = true;
    }
  }

  if (retired) {
    // Short cache: an embed switched back on should reappear quickly, and
    // there is nothing here worth holding at the edge for five minutes.
    return data(
      { retired: true as const },
      { headers: { "Cache-Control": "public, max-age=30" } },
    );
  }

  /* Path first, then the query parameter, then whatever the saved embed
     was configured as. A visitor on /e/x/speakers gets speakers even if
     the token says otherwise. */
  const fromPath = viewFromSlug(params.view);
  const rawView = url.searchParams.get("view") ?? saved?.format ?? "agenda";
  const view: View = fromPath ?? (isView(rawView) ? rawView : "agenda");

  const track =
    url.searchParams.get("track") ??
    (typeof saved?.filters.track === "string" ? saved.filters.track : null);
  const day =
    url.searchParams.get("day") ??
    (typeof saved?.filters.day === "string" ? saved.filters.day : null);

  const loaded = await loadPublicEvent(db, params.eventSlug!, { track, day });
  if (!loaded) throw new Response("Event not found", { status: 404 });

  // Field toggles: saved config first, then per-parameter overrides.
  const fields = parseFields(saved?.fields ?? {});
  for (const key of Object.keys(DEFAULT_FIELDS) as (keyof typeof fields)[]) {
    const q = url.searchParams.get(key);
    if (q === "1" || q === "true") fields[key] = true;
    if (q === "0" || q === "false") fields[key] = false;
  }

  const embed =
    url.searchParams.get("embed") === "1" ||
    url.searchParams.get("embed") === "true";

  return {
    retired: false as const,
    viewerZone: await readViewerZone(request),
    eventZone: loaded.event.timezone,
    ...loaded,
    view,
    fields,
    embed,
    track,
    day,
    ms: Date.now() - started,
  };
}

/* The loader payload arrives as `loaderData`, not `data`. It is undefined
   when the loader threw (an unknown view 404s), and the retired-embed
   branch returns a payload with no event, so both fall back to a title
   that does not pretend to know the event name. */
export function meta({ loaderData }: MetaArgs<typeof loader>) {
  const name =
    loaderData && !loaderData.retired ? loaderData.event.name : null;
  if (!name) return [{ title: "Programme" }];
  return [
    { title: `${name} programme` },
    { name: "description", content: `Sessions and speakers for ${name}.` },
  ];
}

export default function PublicEvent() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  if (data.retired) {
    return (
      <div className="bg-canvas p-6 text-center text-strong">
        <p className="text-[14px] font-medium">This embed is no longer available.</p>
        <p className="mt-1 text-[13px] text-dim">
          The organiser has turned it off.
        </p>
      </div>
    );
  }

  const { event, sessions, speakers, rooms, days, fields, view, embed } = data;

  const body = renderView(view, {
    sessions,
    speakers,
    rooms,
    days,
    fields,
    eventZone: data.eventZone,
    viewerZone: data.viewerZone,
  });

  /* Embedded: just the content. No header, no switcher, no padding that
     fights the host page. */
  if (embed) {
    return <div className="bg-canvas p-3 text-strong">{body}</div>;
  }

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { preventScrollReset: true });
  };

  return (
    <div className="min-h-screen bg-canvas text-strong">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <h1 className="text-[24px] font-semibold tracking-tight">
            {event.name}
          </h1>
          {event.description && (
            <p className="mt-1 max-w-2xl text-[14px] text-dim">
              {event.description}
            </p>
          )}
        </div>

        <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
          {VIEWS.map((v) => (
            <Link
              key={v}
              to={(() => {
                const n = new URLSearchParams(params);
                n.delete("view");
                const qs = n.toString();
                return `/e/${event.slug}/${VIEW_SLUG[v]}${qs ? `?${qs}` : ""}`;
              })()}
              prefetch="intent"
              className={[
                "shrink-0 border-b-2 px-3 py-2 text-[13px] transition-colors",
                v === view
                  ? "border-accent-solid font-medium text-accent-text"
                  : "border-transparent text-dim hover:text-strong",
              ].join(" ")}
            >
              {VIEW_LABEL[v]}
            </Link>
          ))}
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-5">
        {(data.tracks.length > 0 || days.length > 1) && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {days.length > 1 && (
              <select
                value={data.day ?? ""}
                onChange={(e) => setParam("day", e.target.value || null)}
                aria-label="Filter by day"
                className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
              >
                <option value="">All days</option>
                {days.map((d) => (
                  <option key={d} value={d}>
                    {new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </option>
                ))}
              </select>
            )}
            {data.tracks.length > 0 && (
              <select
                value={data.track ?? ""}
                onChange={(e) => setParam("track", e.target.value || null)}
                aria-label="Filter by track"
                className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
              >
                <option value="">All tracks</option>
                {data.tracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <span className="text-[12px] text-dim tabular-nums">
              {view.startsWith("speaker")
                ? `${speakers.length} speaker${speakers.length === 1 ? "" : "s"}`
                : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
            </span>
          </div>
        )}

        {body}

        <p className="mt-6 text-[12px] text-faint">
          Powered by Callboard
          <span className="ml-2 font-mono tabular-nums">{data.ms} ms</span>
        </p>
      </div>
    </div>
  );
}
