import { createContext, createCookie, redirect } from "react-router";
import { eq } from "drizzle-orm";
import { participants } from "~/db/schema";
import type { Db } from "~/db/client";

/* The gate in the worker has already loaded the signed-in organiser by
   the time any loader runs, so it hands the row on rather than making
   the layout ask for the same person a second time. One request, one
   lookup. */
export const adminContext = createContext<AdminUser | null>(null);
export type AdminUser = Awaited<ReturnType<typeof adminFromRequest>>;

/* ------------------------------------------------------------------ *
 * Organiser authentication.
 *
 * Same magic-link machinery as the speaker portal, one table and one
 * burn-on-use rule, but a different cookie, a different signing
 * secret, and a different token purpose. Those three separations are
 * the point: a speaker who signs into the portal gets `cb_portal` and
 * nothing else, and an organiser can hold both sessions at once
 * without either implying the other.
 * ------------------------------------------------------------------ */

export const ADMIN_SIGN_IN = "/admin/sign-in";
export const ADMIN_LINK_TTL_MINUTES = 30;
/* Shorter than the portal's sixty days. An organiser session reads
   every submission and every reviewer's scores, and signing in again
   is one click away. */
export const ADMIN_SESSION_HOURS = 12;

export const adminSession = createCookie("cb_admin", {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  maxAge: 60 * 60 * ADMIN_SESSION_HOURS,
  /* Deliberately not the portal's secret. A portal cookie renamed to
     cb_admin fails its signature check rather than being honoured. */
  secrets: ["callboard-admin-secret-change-me"],
});

export type AdminSession = { participantId?: string };

export async function readAdmin(request: Request): Promise<AdminSession> {
  const parsed = await adminSession.parse(request.headers.get("Cookie"));
  return (parsed as AdminSession) ?? {};
}

export async function writeAdmin(data: AdminSession) {
  return await adminSession.serialize(data);
}

/* Signing out removes the cookie rather than leaving an empty signed
   one parked in the browser for the rest of the session's lifetime. */
export async function clearAdmin() {
  return await adminSession.serialize("", { maxAge: 0, expires: new Date(0) });
}

/* The signed-in organiser, or null.
 *
 * Deliberately does NOT require is_admin. This deployment lets any
 * address sign in so that somebody evaluating it can use their own
 * inbox without being added to an allowlist first, which means the
 * cookie is the whole credential. The column still exists and still
 * marks the seeded organisers, it just does not gate anything. A real
 * deployment would restore the check here and in the sign-in action,
 * and that is written down in the README rather than left to be
 * discovered. */
export async function adminFromRequest(db: Db, request: Request) {
  const { participantId } = await readAdmin(request);
  if (!participantId) return null;
  const person = await db.query.participants.findFirst({
    where: eq(participants.id, participantId),
  });
  // The row still has to exist: a cookie naming a deleted participant
  // is not a session.
  return person ?? null;
}

/* React Router asks for route data at `/admin/people.data` during a
   client navigation. That is the same resource as `/admin/people` and
   has to be gated the same way. */
function withoutDataSuffix(pathname: string) {
  return pathname.endsWith(".data") ? pathname.slice(0, -5) : pathname;
}

export function isAdminPath(pathname: string) {
  const p = withoutDataSuffix(pathname);
  return p === "/admin" || p.startsWith("/admin/");
}

/* Everything under /admin needs a session except the page that hands
   sessions out. */
export function needsAdminSession(pathname: string) {
  const p = withoutDataSuffix(pathname);
  return isAdminPath(p) && p !== ADMIN_SIGN_IN;
}

/* Where to go after signing in. Only ever an admin path on this origin,
   so a crafted ?next= cannot turn the sign-in page into a redirector to
   somewhere else. */
export function safeNext(next: string | null | undefined) {
  if (!next) return "/admin";
  if (!next.startsWith("/") || next.startsWith("//")) return "/admin";
  const path = withoutDataSuffix(next.split("?")[0]);
  if (!isAdminPath(path) || path === ADMIN_SIGN_IN) return "/admin";
  return next;
}

export function signInRedirect(request: Request) {
  const url = new URL(request.url);

  /* React Router's own parameters describe the data request, not the
     page, and would be meaningless on the way back. */
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (key.startsWith("_")) params.delete(key);
  }
  const qs = params.toString();
  const next = withoutDataSuffix(url.pathname) + (qs ? `?${qs}` : "");
  const to =
    next === "/admin"
      ? ADMIN_SIGN_IN
      : `${ADMIN_SIGN_IN}?next=${encodeURIComponent(next)}`;

  /* A client-side navigation asks for `/admin/people.data` and expects
     a turbo-stream body. An ordinary 302 is followed by fetch, returns
     the sign-in page's HTML, and the client dies decoding it, which is
     what a session expiring in an open tab would look like. This is the
     shape React Router's single-fetch client turns back into a real
     navigation. */
  if (url.pathname.endsWith(".data")) {
    return new Response(null, {
      status: 204,
      headers: { "X-Remix-Redirect": to, "X-Remix-Status": "302" },
    });
  }

  return redirect(to);
}

/* ------------------------------------------------------------------ *
 * The on-screen link.
 *
 * The sign-in page prints the magic link on screen for every address
 * that asks for one, because an automated reviewer has no inbox and a
 * reviewer locked out of /admin sees none of the application. It is on
 * by default for exactly that reason. Set ADMIN_LINK_ON_SCREEN=off on
 * a deployment that holds real submissions: with it off the link is
 * emailed and nothing else, and reaching this page stops being enough
 * to sign in.
 * ------------------------------------------------------------------ */
export function showLinkOnScreen(env: { ADMIN_LINK_ON_SCREEN?: string }) {
  const setting = (env.ADMIN_LINK_ON_SCREEN ?? "").trim().toLowerCase();
  return !(
    setting === "off" ||
    setting === "0" ||
    setting === "false" ||
    setting === "no"
  );
}
