/* ------------------------------------------------------------------ *
 * Where this install lives, for anything that has to leave the app.
 *
 * A link inside an email is read somewhere else, hours later. Building
 * it from the request origin means an email triggered from a laptop
 * carries http://localhost:5173, which is a dead link in the reader's
 * inbox and a support ticket for whoever sent it. The origin is a fact
 * about the request; the public address is a fact about the
 * deployment, and only the deployment knows it.
 *
 * PUBLIC_BASE_URL is that fact. Set it as a secret (or a var) and
 * every absolute URL in outgoing mail agrees, whichever host happened
 * to serve the request that triggered the send.
 * ------------------------------------------------------------------ */

export type BaseUrlEnv = { PUBLIC_BASE_URL?: string };

function warn(message: string) {
  // Goes to `wrangler tail` in production and the terminal in dev.
  console.warn(`[callboard] ${message}`);
}

/* The public address of this install, without a trailing slash.
   Falls back to the request origin when the secret is unset, because a
   link built from the wrong host still beats no link at all, and says
   so loudly enough to be found in the logs. */
export function publicBaseUrl(env: BaseUrlEnv, request: Request): string {
  const origin = new URL(request.url).origin;
  const configured = (env.PUBLIC_BASE_URL ?? "").trim();

  if (!configured) {
    warn(
      `PUBLIC_BASE_URL is not set. Falling back to the request origin (${origin}). ` +
        `Links in outgoing email will point at that host, which is wrong for anything ` +
        `triggered from a machine the recipient cannot reach.`,
    );
    return origin;
  }

  /* A value without a scheme, or with a stray path, produces links that
     look right and resolve nowhere. Better to catch it here than in
     somebody's inbox. */
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    warn(
      `PUBLIC_BASE_URL is set to "${configured}", which is not a valid absolute URL ` +
        `(it needs a scheme, as https://example.com). Falling back to ${origin}.`,
    );
    return origin;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warn(
      `PUBLIC_BASE_URL uses the "${parsed.protocol}" scheme, which is not a web address. ` +
        `Falling back to ${origin}.`,
    );
    return origin;
  }

  // Keep the origin only. A base URL carrying a path, query or hash
  // would corrupt every link built by appending to it.
  return parsed.origin;
}
