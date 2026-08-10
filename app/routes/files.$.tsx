import type { LoaderFunctionArgs } from "react-router";
import { cloudflareContext } from "~/db/client";

/* ------------------------------------------------------------------ *
 * Serves uploaded files back out of R2.
 *
 * These objects come from users and are served from the app's own
 * origin, so the response headers matter as much as the upload
 * validation did:
 *
 *   - nosniff, so a mislabelled file cannot be reinterpreted as HTML.
 *   - Images render inline because headshots are meant to be shown.
 *     Everything else is forced to download, so nothing user supplied
 *     ever executes in this origin.
 *   - The content type is the one the uploader verified by sniffing the
 *     bytes, not anything the browser claimed at upload time.
 * ------------------------------------------------------------------ */

const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function loader({ context, params, request }: LoaderFunctionArgs) {
  const raw = params["*"] ?? "";

  // Defensive: the key is a URL path, so make sure it cannot walk out of
  // the prefix even if something upstream changes.
  const key = raw
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");

  if (!key.startsWith("events/") || key.includes("..") || key.includes("\\")) {
    throw new Response("Not found", { status: 404 });
  }

  const { env } = context.get(cloudflareContext);
  const bucket = (env as unknown as { BUCKET?: R2Bucket }).BUCKET;

  if (!bucket) {
    throw new Response("File storage is not configured on this deployment.", {
      status: 503,
    });
  }

  const object = await bucket.get(key);
  if (!object) throw new Response("Not found", { status: 404 });

  const contentType =
    object.httpMetadata?.contentType ?? "application/octet-stream";
  const inline = INLINE_TYPES.has(contentType);
  const filename = key.split("/").pop() ?? "download";

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(object.size));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${filename}"`,
  );
  // Headshots end up on the public programme, so they are cacheable.
  // Slides are not public and should not sit in a shared cache.
  headers.set(
    "Cache-Control",
    inline ? "public, max-age=3600" : "private, no-store",
  );
  if (object.httpEtag) headers.set("ETag", object.httpEtag);

  // Cheap revalidation for the images that get requested repeatedly.
  if (object.httpEtag && request.headers.get("If-None-Match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
}
