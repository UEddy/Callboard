import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext, dbFromEnv } from "../app/db/client";
import {
  adminFromRequest,
  needsAdminSession,
  signInRedirect,
} from "../app/lib/admin-auth";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
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
      if (!admin) return signInRedirect(request);
    }

    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
