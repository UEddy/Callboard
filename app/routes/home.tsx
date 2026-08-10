import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { asc } from "drizzle-orm";
import { getDb } from "~/db/client";
import { events } from "~/db/schema";

/* ------------------------------------------------------------------ *
 * The root is the public programme, not a framework welcome page.
 *
 * A single-event install has one obvious front door, so / goes there
 * rather than making a visitor guess the slug. With no event at all
 * there is nothing public to show, so the admin is the only sensible
 * destination.
 * ------------------------------------------------------------------ */

export async function loader({ context }: LoaderFunctionArgs) {
  const db = getDb(context);
  const event = await db
    .select({ slug: events.slug })
    .from(events)
    .orderBy(asc(events.createdAt))
    .limit(1)
    .then((r) => r[0]);

  if (!event) return redirect("/admin");

  return redirect(`/e/${event.slug}`, {
    // The destination is the cacheable thing; this hop is not, so a new
    // event slug takes effect immediately.
    headers: { "Cache-Control": "no-store" },
  });
}
