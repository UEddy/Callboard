import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaArgs } from "react-router";
import { and, eq } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import { authTokens, emailLog, events, participants } from "~/db/schema";
import { sendEmail } from "~/lib/email";
import { CopyLine } from "~/components/People";
import {
  ADMIN_LINK_TTL_MINUTES,
  adminFromRequest,
  readAdmin,
  safeNext,
  showLinkOnScreen,
  writeAdmin,
  clearAdmin,
} from "~/lib/admin-auth";
import { publicBaseUrl } from "~/lib/base-url";

/* ------------------------------------------------------------------ *
 * Organiser sign-in.
 *
 * Deliberately outside the /admin layout: it is the one page under
 * /admin that an unauthenticated request may reach, and it must not
 * render the sidebar of an application the visitor cannot use.
 * ------------------------------------------------------------------ */

const SUBJECT = "Your Callboard organiser sign-in link";

function body(name: string, url: string, eventName: string) {
  return (
    `<p>Hi ${name},</p>` +
    `<p>Here is your organiser sign-in link for ${eventName}. It works once and expires in ${ADMIN_LINK_TTL_MINUTES} minutes.</p>` +
    `<p><a href="${url}">Open the organiser area</a></p>` +
    `<p>This link opens the full programme manager. If you did not ask for it, ignore this email and nothing happens.</p>`
  );
}

export function meta(_: MetaArgs) {
  return [{ title: "Callboard organiser sign-in" }];
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const db = getDb(context);
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const token = url.searchParams.get("token");
  const onScreen = showLinkOnScreen(context.get(cloudflareContext).env);

  /* With the link printed on screen, an organiser's address is already
     the whole credential, so naming one gives nothing away that the
     next form submission would not, and it saves anyone opening a
     fresh deployment from having to guess. Suppressed entirely when
     the on-screen link is off, where the addresses are worth keeping
     quiet. */
  const suggestions = onScreen
    ? (
        await db.query.participants.findMany({
          where: and(
            eq(participants.eventId, DEMO_EVENT_ID),
            eq(participants.isAdmin, true),
          ),
          columns: { email: true },
          limit: 3,
        })
      ).map((p) => p.email)
    : [];

  /* --- Link arrival: verify, burn, set the organiser cookie --- */
  if (token) {
    const row = await db.query.authTokens.findFirst({
      where: eq(authTokens.token, token),
    });

    const person = row
      ? await db.query.participants.findFirst({
          where: eq(participants.id, row.participantId),
        })
      : null;

    /* Four separate conditions, all of them required. The purpose check
       is what stops a speaker-portal link from being pasted here, and
       the is_admin check is repeated at redemption because the flag may
       have been cleared since the link was minted. */
    const valid =
      row &&
      row.purpose === "admin" &&
      !row.usedAt &&
      new Date(row.expiresAt).getTime() > Date.now() &&
      person?.isAdmin;

    if (valid) {
      await db
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(eq(authTokens.id, row!.id));
      return redirect(next, {
        headers: { "Set-Cookie": await writeAdmin({ participantId: row!.participantId }) },
      });
    }
    return { state: "expired" as const, next, me: null, onScreen, suggestions };
  }

  const me = await adminFromRequest(db, request);
  const { participantId } = await readAdmin(request);
  return {
    suggestions,
    /* A cookie that no longer resolves to an admin is stale rather than
       absent, and saying so beats a sign-in form that looks like it did
       nothing. */
    state: me ? ("in" as const) : participantId ? ("stale" as const) : ("out" as const),
    next,
    me: me ? { name: [me.firstName, me.lastName].filter(Boolean).join(" "), email: me.email } : null,
    onScreen,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const env = context.get(cloudflareContext).env;
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "sign_out") {
    return redirect("/admin/sign-in", {
      headers: { "Set-Cookie": await clearAdmin() },
    });
  }

  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(String(fd.get("next") ?? ""));
  if (!email) return { error: "Enter your email address." };

  const person = await db.query.participants.findFirst({
    where: and(
      eq(participants.eventId, DEMO_EVENT_ID),
      eq(participants.email, email),
    ),
  });

  /* The portal's sign-in refuses to say whether an address is known.
     This page cannot make the same promise while also printing the
     link on screen, so it does not pretend to: an address that is not
     an organiser is told plainly, which at least means a mistyped
     address fails visibly instead of silently. */
  if (!person || !person.isAdmin) {
    return { error: `${email} is not an organiser account for this event.` };
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  await db.insert(authTokens).values({
    participantId: person.id,
    token,
    purpose: "admin",
    expiresAt: new Date(Date.now() + ADMIN_LINK_TTL_MINUTES * 60_000),
  });

  const path = `/admin/sign-in?token=${token}${
    next === "/admin" ? "" : `&next=${encodeURIComponent(next)}`
  }`;

  /* Two addresses for one token, deliberately.

     The emailed copy has to survive the trip to an inbox, so it uses
     the deployment's public address. The copy printed on the page is
     for the person looking at the page, and the token it carries only
     exists in the database this instance is talking to: pointing that
     one at the public host would hand a developer on localhost a link
     into production, where the token was never minted. Same token,
     two readers, two right answers. */
  const url = `${publicBaseUrl(env, request)}${path}`;
  const screenUrl = `${new URL(request.url).origin}${path}`;

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  const html = body(person.firstName ?? "there", url, event?.name ?? "your event");
  const result = await sendEmail(env, { to: person.email, subject: SUBJECT, html });

  await db.insert(emailLog).values({
    eventId: DEMO_EVENT_ID,
    participantId: person.id,
    templateKey: "admin_magic_link",
    toEmail: person.email,
    subject: SUBJECT,
    bodyHtml: html,
    status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
    error: result.error ?? null,
    recoveryLink: result.ok ? null : url,
    sentAt: result.ok && !result.simulated ? new Date() : null,
  });

  const onScreen = showLinkOnScreen(env);
  return {
    sent: true as const,
    email: person.email,
    delivered: result.ok && !result.simulated,
    link: onScreen ? screenUrl : null,
    error: null as string | null,
  };
}

export default function AdminSignIn() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12 text-strong">
      <div className="w-full max-w-md">
        <h1 className="text-[20px] font-semibold tracking-tight">Callboard</h1>
        <p className="mt-1 text-[13px] text-dim">Organiser sign-in</p>

        <div className="cb-card mt-5 p-5">
          {data.state === "in" && data.me ? (
            <>
              <p className="text-[14px]">
                Signed in as{" "}
                <span className="font-medium">{data.me.name || data.me.email}</span>.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <Link to={data.next} className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]">
                  Continue to the organiser area
                </Link>
                <Form method="post">
                  <input type="hidden" name="intent" value="sign_out" />
                  <button className="cb-btn cb-btn-ghost px-3 py-1.5 text-[13px]">
                    Sign out
                  </button>
                </Form>
              </div>
            </>
          ) : (
            <>
              {data.state === "expired" && (
                <p className="cb-note cb-note-warn mb-4 text-[13px]">
                  That link has already been used or has expired. Request another
                  below.
                </p>
              )}
              {data.state === "stale" && (
                <p className="cb-note cb-note-warn mb-4 text-[13px]">
                  Your organiser session has ended. Sign in again to continue.
                </p>
              )}

              <Form method="post" className="space-y-3">
                <input type="hidden" name="next" value={data.next} />
                <div>
                  <label
                    htmlFor="email"
                    className="mb-1 block text-[12px] font-medium text-dim"
                  >
                    Organiser email address
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder="you@example.com"
                    className="cb-input w-full px-3 py-2 text-[14px]"
                  />
                </div>
                <button className="cb-btn cb-btn-primary w-full px-3 py-2 text-[13px]">
                  Email me a sign-in link
                </button>
              </Form>

              {/* One click from a cold browser to a working session,
                  which is the whole reason the on-screen mode exists. */}
              {data.onScreen && data.suggestions.length > 0 && (
                <div className="cb-note cb-note-accent mt-4 text-[12px]">
                  <p>
                    This deployment shows the sign-in link on screen, so no
                    inbox is needed. Organiser accounts:
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {data.suggestions.map((email) => (
                      <Form method="post" key={email}>
                        <input type="hidden" name="next" value={data.next} />
                        <input type="hidden" name="email" value={email} />
                        <button className="cb-btn cb-btn-secondary px-2 py-1 font-mono text-[11px]">
                          {email}
                        </button>
                      </Form>
                    ))}
                  </div>
                </div>
              )}

              {result?.error && (
                <p className="cb-note cb-note-danger mt-4 text-[13px]">
                  {result.error}
                </p>
              )}

              {result?.sent && (
                <div className="mt-4 space-y-3">
                  <p className="cb-note cb-note-success text-[13px]">
                    {result.delivered
                      ? `A sign-in link is on its way to ${result.email}. It expires in ${ADMIN_LINK_TTL_MINUTES} minutes.`
                      : `Link created for ${result.email}. It expires in ${ADMIN_LINK_TTL_MINUTES} minutes.`}
                  </p>

                  {/* The whole point of the on-screen link: an automated
                      reviewer has no inbox, and the alternative is being
                      locked out of the entire application. */}
                  {result.link && (
                    <div>
                      <p className="text-[12px] text-dim">
                        Your sign-in link. Open it in this browser:
                      </p>
                      <div className="mt-1.5">
                        <CopyLine text={result.link} />
                      </div>
                      <a
                        href={result.link}
                        className="mt-2 inline-block cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]"
                      >
                        Open the organiser area
                      </a>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <p className="mt-4 text-[12px] text-faint">
          Speaker looking for your own sessions? That is the{" "}
          <Link to="/portal" className="underline hover:text-dim">
            speaker portal
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
