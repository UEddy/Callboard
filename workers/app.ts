import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext, dbFromEnv } from "../app/db/client";
import {
  adminContext,
  adminFromRequest,
  needsAdminSession,
  signInRedirect,
} from "../app/lib/admin-auth";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/* Statuses whose responses are defined to carry no body. Rebuilding one
   with a body, even a null one taken from the original, throws. */
const BODYLESS = new Set([101, 204, 205, 304]);

/* The number the page cannot report about itself.
 *
 * The badge in the corner is measured inside a loader and read when it
 * returns, so it counts data fetching and nothing else: not rendering,
 * not serialisation, not the organiser gate below. On a page like
 * /admin/settings, whose loader is trivial but which renders a option
 * per timezone, those two numbers differ by an order of magnitude.
 *
 * This one wraps everything, which means it can only be known once the
 * HTML has already been produced. That is why it goes in a header
 * rather than on the page. */
function withTiming(response: Response, startedAt: number): Response {
  const dur = Date.now() - startedAt;
  const headers = new Headers(response.headers);
  headers.append("Server-Timing", `total;dur=${dur}`);

  return new Response(BODYLESS.has(response.status) ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    // Started here rather than around the router, so the gate's own
    // round trip to D1 is counted rather than hidden.
    const startedAt = Date.now();

    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });

    /* The organiser gate sits in front of the router rather than in the
       admin layout's loader. A child route's action runs without its
       parent's loader ever being called, so a loader-only check would
       leave every POST under /admin open while looking protected. Here
       nothing under /admin (page, data request, form post, CSV
       download, or any route added later) reaches the router without a
       session. */
    const { pathname } = new URL(request.url);
    if (needsAdminSession(pathname)) {
      const admin = await adminFromRequest(dbFromEnv(env), request);
      if (!admin) return withTiming(signInRedirect(request), startedAt);
      // Passed on so the layout can name who is signed in without
      // repeating the lookup.
      context.set(adminContext, admin);
    }

    return withTiming(await requestHandler(request, context), startedAt);
  },
} satisfies ExportedHandler<Env>;
