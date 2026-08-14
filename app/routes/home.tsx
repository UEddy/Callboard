import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

/* ------------------------------------------------------------------ *
 * The root is the organiser area, not a framework welcome page.
 *
 * Somebody who types the bare domain is nearly always the person
 * running the event, so / goes to /admin, which sends them on to the
 * organiser sign-in if they are not already in. The public programme
 * is what gets linked and embedded, and it has its own stable URL at
 * /e/:eventSlug that does not depend on this hop.
 * ------------------------------------------------------------------ */

export async function loader(_: LoaderFunctionArgs) {
  // No database read: the destination is fixed, so this stays a cheap
  // redirect rather than a query that only decides where to send one
  // person.
  return redirect("/admin", { headers: { "Cache-Control": "no-store" } });
}
