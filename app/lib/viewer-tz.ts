import { createCookie } from "react-router";
import { isValidZone } from "./tz";

/* ------------------------------------------------------------------ *
 * The viewer's own timezone.
 *
 * A cookie rather than a client-only lookup, because the secondary
 * "(5:00 PM your time)" has to be in the server rendered HTML or it
 * pops in after hydration on every page.
 *
 * Written by the browser directly, like the theme, so detecting it
 * costs no request and triggers no revalidation.
 * ------------------------------------------------------------------ */

export const VIEWER_TZ_COOKIE = "cb_tz";

export const viewerTzCookie = createCookie(VIEWER_TZ_COOKIE, {
  path: "/",
  sameSite: "lax",
  httpOnly: false,
  maxAge: 60 * 60 * 24 * 180,
});

export async function readViewerZone(request: Request): Promise<string | null> {
  const parsed = await viewerTzCookie.parse(request.headers.get("Cookie"));
  return isValidZone(parsed) ? parsed : null;
}
