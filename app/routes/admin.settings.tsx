import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { eq, and, ne } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import { events } from "~/db/schema";
import {
  allZones,
  describeZone,
  dayIsoIn,
  fmtDateIn,
  fromZonedInput,
  isValidZone,
  partsIn,
  safeZone,
  toZonedInput,
  wallToUtc,
  zoneAbbr,
} from "~/lib/tz";
import { readViewerZone } from "~/lib/viewer-tz";

/* ------------------------------------------------------------------ *
 * Event settings.
 *
 * The timezone here is not decoration: every displayed time in the app
 * is derived from it. Changing it re-reads every stored instant in the
 * new zone rather than moving any data, which is the behaviour a
 * producer expects when they realise they picked the wrong city.
 *
 * Start and end are entered as wall clock times in the event's own zone
 * and stored as UTC instants, so the stored value is unambiguous and the
 * displayed value is what the venue clock will say.
 * ------------------------------------------------------------------ */

const EVENT_TYPES = [
  "Conference",
  "Meetup",
  "Workshop series",
  "Hackathon",
  "Summit",
  "Unconference",
  "Online only",
];

/* datetime-local wants a wall clock reading, not an instant. Both
   directions live in ~/lib/tz now, shared with the form builder's close
   date, because two screens editing an instant in two different zones is
   how a deadline ends up nine hours out. */
const toLocalInput = toZonedInput;
const fromLocalInput = fromZonedInput;

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  if (!event) throw new Response("Event not found", { status: 404 });

  const zone = safeZone(event.timezone);
  const now = Date.now();

  return {
    event: {
      name: event.name,
      slug: event.slug,
      eventType: event.eventType ?? "",
      websiteUrl: event.websiteUrl ?? "",
      location: event.location ?? "",
      timezone: zone,
      description: event.description ?? "",
      logoUrl: event.logoUrl ?? "",
      backgroundUrl: event.backgroundUrl ?? "",
      startsAtInput: toLocalInput(
        event.startsAt ? new Date(event.startsAt).getTime() : null,
        zone,
      ),
      endsAtInput: toLocalInput(
        event.endsAt ? new Date(event.endsAt).getTime() : null,
        zone,
      ),
      startsAtMs: event.startsAt ? new Date(event.startsAt).getTime() : null,
    },
    zones: allZones(),
    zoneLabel: describeZone(zone, now),
    viewerZone: await readViewerZone(request),
    ms: Date.now() - started,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();

  const name = String(fd.get("name") ?? "").trim();
  const slug = String(fd.get("slug") ?? "").trim().toLowerCase();
  const timezone = String(fd.get("timezone") ?? "").trim();

  if (!name) return { error: "The event needs a name." };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return {
      error:
        "The slug can only contain lowercase letters, numbers and hyphens, and cannot start with a hyphen. It appears in the public URL.",
    };
  }
  if (!isValidZone(timezone)) {
    return { error: "That is not a timezone this server recognises." };
  }

  // The slug is the public address of the event, so a clash is a real
  // collision rather than a validation nicety.
  const clash = await db.query.events.findFirst({
    where: and(eq(events.slug, slug), ne(events.id, DEMO_EVENT_ID)),
  });
  if (clash) {
    return { error: `Another event already uses the address "${slug}".` };
  }

  const startsAt = fromLocalInput(String(fd.get("startsAt") ?? ""), timezone);
  const endsAt = fromLocalInput(String(fd.get("endsAt") ?? ""), timezone);

  if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
    return { error: "The end date is before the start date." };
  }

  await db
    .update(events)
    .set({
      name,
      slug,
      eventType: String(fd.get("eventType") ?? "").trim() || null,
      websiteUrl: String(fd.get("websiteUrl") ?? "").trim() || null,
      location: String(fd.get("location") ?? "").trim() || null,
      timezone,
      description: String(fd.get("description") ?? "").trim() || null,
      logoUrl: String(fd.get("logoUrl") ?? "").trim() || null,
      backgroundUrl: String(fd.get("backgroundUrl") ?? "").trim() || null,
      startsAt,
      endsAt,
      updatedAt: new Date(),
    })
    .where(eq(events.id, DEMO_EVENT_ID));

  return { saved: true };
}

const field =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong";

export default function Settings() {
  const { event, zones, zoneLabel, viewerZone, ms } =
    useLoaderData<typeof loader>();
  const action = useActionData<{ error?: string; saved?: boolean }>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const now = Date.now();
  const sample = event.startsAtMs ?? now;

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              Event settings
            </h1>
            <p className="mt-0.5 text-[13px] text-dim">
              The name, dates and timezone everything else in Callboard is
              derived from.
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>
      </div>

      <div className="max-w-3xl px-6 py-5">
        {action?.error && (
          <p className="cb-note cb-note-danger mb-4 px-3 py-2.5 text-[13px]">
            {action.error}
          </p>
        )}
        {action?.saved && (
          <p className="cb-note cb-note-success mb-4 px-3 py-2.5 text-[13px]">
            Saved. Every time in the app now reads in {zoneLabel}.
          </p>
        )}

        <Form method="post" className="space-y-6">
          <section className="space-y-4 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[14px] font-semibold">Identity</h2>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[13px] font-medium">Event name</span>
                <input name="name" defaultValue={event.name} className={field} />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Event type</span>
                <input
                  name="eventType"
                  list="event-types"
                  defaultValue={event.eventType}
                  placeholder="Conference"
                  className={field}
                />
                <datalist id="event-types">
                  {EVENT_TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </label>
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">Public address</span>
              <span className="block text-[12px] text-dim">
                Used in the public programme URL and in calendar invite
                identifiers. Changing it changes those links.
              </span>
              <div className="mt-1 flex items-center gap-1">
                <span className="text-[13px] text-dim">/e/</span>
                <input
                  name="slug"
                  defaultValue={event.slug}
                  className={`${field} mt-0 font-mono`}
                />
              </div>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[13px] font-medium">Website</span>
                <input
                  name="websiteUrl"
                  type="url"
                  defaultValue={event.websiteUrl}
                  placeholder="https://example.com"
                  className={field}
                />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Location</span>
                <input
                  name="location"
                  defaultValue={event.location}
                  placeholder="San Francisco, CA"
                  className={field}
                />
              </label>
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">Description</span>
              <textarea
                name="description"
                rows={3}
                defaultValue={event.description}
                className={field}
              />
            </label>
          </section>

          <section className="space-y-4 rounded-lg border border-line bg-surface p-4">
            <div>
              <h2 className="text-[14px] font-semibold">When</h2>
              <p className="mt-0.5 text-[12px] text-dim">
                Times are entered and shown in the event's own timezone.
                Callboard stores the exact instant, so a later timezone change
                re-reads the same moment rather than shifting your schedule.
              </p>
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">Timezone</span>
              <select
                name="timezone"
                defaultValue={event.timezone}
                className={field}
              >
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {describeZone(z, sample)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[12px] text-dim">
                Currently {zoneLabel}.
                {viewerZone && viewerZone !== event.timezone && (
                  <> You are browsing from {viewerZone.replace(/_/g, " ")}.</>
                )}
              </span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[13px] font-medium">Starts</span>
                <input
                  type="datetime-local"
                  name="startsAt"
                  defaultValue={event.startsAtInput}
                  className={field}
                />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Ends</span>
                <input
                  type="datetime-local"
                  name="endsAt"
                  defaultValue={event.endsAtInput}
                  className={field}
                />
              </label>
            </div>

            {event.startsAtMs !== null && (
              <div className="rounded-md bg-subtle px-3 py-2 text-[12px] text-body">
                <span className="font-medium text-strong">
                  What this means
                </span>
                <br />
                The event opens{" "}
                {fmtDateIn(event.startsAtMs, event.timezone, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}{" "}
                at{" "}
                {new Intl.DateTimeFormat("en-US", {
                  timeZone: event.timezone,
                  hour: "numeric",
                  minute: "2-digit",
                }).format(event.startsAtMs)}{" "}
                {zoneAbbr(event.startsAtMs, event.timezone)}
                {viewerZone && viewerZone !== event.timezone && (
                  <>
                    , which is{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      timeZone: viewerZone,
                      weekday: "long",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(event.startsAtMs)}{" "}
                    where you are
                  </>
                )}
                .
              </div>
            )}
          </section>

          <section className="space-y-4 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[14px] font-semibold">Branding</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[13px] font-medium">Logo URL</span>
                <input
                  name="logoUrl"
                  type="url"
                  defaultValue={event.logoUrl}
                  placeholder="https://..."
                  className={field}
                />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Background URL</span>
                <input
                  name="backgroundUrl"
                  type="url"
                  defaultValue={event.backgroundUrl}
                  placeholder="https://..."
                  className={field}
                />
              </label>
            </div>
          </section>

          <button
            disabled={busy}
            className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
          >
            {busy ? "Saving" : "Save settings"}
          </button>
        </Form>
      </div>
    </div>
  );
}
