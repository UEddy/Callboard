import { useState } from "react";
import { Form, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import { embeds, events, tracks } from "~/db/schema";
import {
  DEFAULT_FIELDS,
  isView,
  VIEWS,
  VIEW_LABEL,
  parseFields,
  type FieldToggles,
} from "~/lib/public-event";

/* ------------------------------------------------------------------ *
 * Embeds: the producer's side of the public display layer.
 *
 * Each row is a saved configuration with a public token. The token is
 * what the iframe URL carries, so a producer can change the filters or
 * the visible fields later and every page that embedded it updates
 * without anyone editing HTML.
 * ------------------------------------------------------------------ */

const FIELD_LABEL: Record<keyof FieldToggles, string> = {
  showRoom: "Room",
  showTrack: "Track",
  showSpeakers: "Speakers",
  showLevel: "Audience level",
  showFormat: "Format",
  showAbstract: "Abstract",
  showCompany: "Company and job title",
  showBio: "Biography",
  showLinks: "Social links",
};

/* Which toggles are meaningful for which view, so the producer is not
   offered "Biography" on an agenda grid. */
const RELEVANT: Record<string, (keyof FieldToggles)[]> = {
  agenda: ["showSpeakers", "showTrack"],
  session_list: [
    "showTrack",
    "showFormat",
    "showLevel",
    "showSpeakers",
    "showRoom",
    "showAbstract",
  ],
  schedule_itinerary: [
    "showSpeakers",
    "showRoom",
    "showTrack",
    "showLevel",
    "showAbstract",
  ],
  speaker_list: ["showCompany", "showBio", "showLinks"],
  speaker_gallery: ["showCompany", "showBio", "showLinks"],
};

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  const rows = await db
    .select()
    .from(embeds)
    .where(eq(embeds.eventId, DEMO_EVENT_ID))
    .orderBy(embeds.createdAt);

  const trackList = await db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, DEMO_EVENT_ID))
    .orderBy(tracks.sortOrder);

  return {
    origin: new URL(request.url).origin,
    eventSlug: event?.slug ?? "",
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      format: r.format,
      enabled: r.enabled,
      publicToken: r.publicToken,
      filters: (r.filters ?? {}) as Record<string, unknown>,
      fields: parseFields(r.fields),
    })),
    trackList,
    ms: Date.now() - started,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "create") {
    const format = String(fd.get("format") ?? "agenda");
    await db.insert(embeds).values({
      eventId: DEMO_EVENT_ID,
      name: `New ${VIEW_LABEL[isView(format) ? format : "agenda"].toLowerCase()}`,
      format: isView(format) ? format : "agenda",
      enabled: true,
      publicToken: `pub_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      filters: {},
      fields: DEFAULT_FIELDS,
    });
    return { ok: true };
  }

  if (intent === "delete") {
    await db.delete(embeds).where(eq(embeds.id, String(fd.get("embedId"))));
    return { ok: true };
  }

  if (intent === "save") {
    const id = String(fd.get("embedId"));
    const format = String(fd.get("format") ?? "agenda");

    const fields: Record<string, boolean> = {};
    for (const key of Object.keys(DEFAULT_FIELDS)) {
      fields[key] = fd.get(`field_${key}`) === "on";
    }

    const track = String(fd.get("track") ?? "").trim();
    const day = String(fd.get("day") ?? "").trim();

    await db
      .update(embeds)
      .set({
        name: String(fd.get("name") ?? "Untitled"),
        format: isView(format) ? format : "agenda",
        enabled: fd.get("enabled") === "on",
        filters: {
          ...(track ? { track } : {}),
          ...(day ? { day } : {}),
          status: ["accepted"],
        },
        fields,
      })
      .where(eq(embeds.id, id));
    return { ok: true };
  }

  return { ok: false };
}

function snippet(origin: string, slug: string, token: string) {
  const src = `${origin}/e/${slug}?token=${token}&embed=1`;
  return `<iframe src="${src}" style="width:100%;border:0;min-height:600px" loading="lazy" title="Programme"></iframe>`;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1800);
          },
          () => setDone(false),
        );
      }}
      className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export default function Embeds() {
  const { origin, eventSlug, rows, trackList, ms } =
    useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Embeds</h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Publish the programme on your own site. Each embed is a saved
              view you can change later without touching the host page.
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {VIEWS.map((v) => (
            <Form method="post" key={v}>
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="format" value={v} />
              <button
                disabled={busy}
                className="cb-btn cb-btn-secondary px-2.5 py-1.5 text-[13px]"
              >
                New {VIEW_LABEL[v].toLowerCase()}
              </button>
            </Form>
          ))}
          <a
            href={`/e/${eventSlug}`}
            target="_blank"
            rel="noreferrer"
            className="cb-btn cb-btn-primary px-2.5 py-1.5 text-[13px]"
          >
            Open public site
          </a>
        </div>
      </div>

      <div className="space-y-3 px-6 py-4">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
            <p className="text-[14px] font-medium text-strong">No embeds yet</p>
            <p className="mt-1 text-[13px] text-dim">
              Create one above to get an iframe snippet.
            </p>
          </div>
        ) : (
          rows.map((r) => {
            const code = snippet(origin, eventSlug, r.publicToken);
            const previewUrl = `/e/${eventSlug}?token=${r.publicToken}&embed=1`;
            const relevant = RELEVANT[r.format] ?? [];
            return (
              <div
                key={r.id}
                className="overflow-hidden rounded-lg border border-line bg-surface"
              >
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="text-[14px] font-medium text-strong">
                    {r.name}
                  </span>
                  <span className="cb-pill cb-pill-neutral">
                    {VIEW_LABEL[r.format as keyof typeof VIEW_LABEL] ??
                      r.format}
                  </span>
                  <span
                    className={`cb-pill ${r.enabled ? "cb-pill-success" : "cb-pill-neutral"}`}
                  >
                    {r.enabled ? "live" : "off"}
                  </span>
                  {typeof r.filters.track === "string" && (
                    <span className="cb-pill cb-pill-accent">
                      {trackList.find((t) => t.id === r.filters.track)?.name ??
                        "track filter"}
                    </span>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
                    >
                      Preview
                    </a>
                    <button
                      type="button"
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
                    >
                      {open === r.id ? "Close" : "Configure"}
                    </button>
                  </div>
                </div>

                {/* Snippet is always visible: it is the thing people came for */}
                <div className="flex items-start gap-2 border-t border-line-soft bg-subtle px-4 py-2.5">
                  <code className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-body">
                    {code}
                  </code>
                  <CopyButton text={code} />
                </div>

                {open === r.id && (
                  <Form
                    method="post"
                    className="space-y-4 border-t border-line-soft px-4 py-4"
                  >
                    <input type="hidden" name="intent" value="save" />
                    <input type="hidden" name="embedId" value={r.id} />

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="text-[13px] font-medium">Name</span>
                        <input
                          name="name"
                          defaultValue={r.name}
                          className="mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[13px] font-medium">Format</span>
                        <select
                          name="format"
                          defaultValue={r.format}
                          className="mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong"
                        >
                          {VIEWS.map((v) => (
                            <option key={v} value={v}>
                              {VIEW_LABEL[v]}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="text-[13px] font-medium">Track</span>
                        <select
                          name="track"
                          defaultValue={
                            typeof r.filters.track === "string"
                              ? r.filters.track
                              : ""
                          }
                          className="mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong"
                        >
                          <option value="">All tracks</option>
                          {trackList.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-[13px] font-medium">Day</span>
                        <input
                          type="date"
                          name="day"
                          defaultValue={
                            typeof r.filters.day === "string"
                              ? r.filters.day
                              : ""
                          }
                          className="mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong"
                        />
                      </label>
                    </div>

                    <fieldset>
                      <legend className="text-[13px] font-medium">
                        Fields to show
                      </legend>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                        {(
                          Object.keys(DEFAULT_FIELDS) as (keyof FieldToggles)[]
                        ).map((key) => {
                          const applies = relevant.includes(key);
                          return (
                            <label
                              key={key}
                              className={[
                                "flex items-center gap-1.5 text-[13px]",
                                applies ? "text-body" : "text-faint",
                              ].join(" ")}
                              title={
                                applies
                                  ? undefined
                                  : `Not used by the ${VIEW_LABEL[r.format as keyof typeof VIEW_LABEL] ?? r.format} view`
                              }
                            >
                              <input
                                type="checkbox"
                                name={`field_${key}`}
                                defaultChecked={r.fields[key]}
                                className="h-4 w-4 rounded border-line-strong"
                              />
                              {FIELD_LABEL[key]}
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={r.enabled}
                        className="h-4 w-4 rounded border-line-strong"
                      />
                      <span className="text-[13px]">
                        Live. Turning this off makes the embed stop rendering
                        on any site using it.
                      </span>
                    </label>

                    <div className="flex items-center gap-2">
                      <button
                        disabled={busy}
                        className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
                      >
                        {busy ? "Saving" : "Save embed"}
                      </button>
                      <button
                        formAction="/admin/embeds"
                        name="intent"
                        value="delete"
                        disabled={busy}
                        className="cb-btn cb-btn-danger ml-auto px-2 py-1 text-[12px]"
                      >
                        Delete
                      </button>
                    </div>
                  </Form>
                )}

                {open === r.id && (
                  <div className="border-t border-line-soft">
                    <div className="border-b border-line-soft bg-subtle px-4 py-1.5 text-[11px] uppercase tracking-[0.06em] text-dim">
                      Live preview
                    </div>
                    <iframe
                      src={previewUrl}
                      title={`${r.name} preview`}
                      className="h-96 w-full border-0 bg-canvas"
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
