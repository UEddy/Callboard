import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { and, eq } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  authTokens,
  emailLog,
  emailTemplates,
  events,
  participants,
  submissions,
} from "~/db/schema";
import { CopyLine } from "~/components/People";
import { BodyFrame } from "~/components/EmailBody";
import { ONE_OFF_KEY } from "~/lib/emails";
import { fmtWhenIn, safeZone } from "~/lib/tz";

/* ------------------------------------------------------------------ *
 * One sent email, as the recipient got it.
 *
 * Rows written before the log kept bodies have no body to show, and the
 * page says so rather than rendering an empty frame that reads like the
 * email was blank.
 * ------------------------------------------------------------------ */

export async function loader({ context, params }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const row = await db
    .select({
      id: emailLog.id,
      toEmail: emailLog.toEmail,
      subject: emailLog.subject,
      bodyHtml: emailLog.bodyHtml,
      recoveryLink: emailLog.recoveryLink,
      templateKey: emailLog.templateKey,
      status: emailLog.status,
      error: emailLog.error,
      icsUid: emailLog.icsUid,
      icsSequence: emailLog.icsSequence,
      sentAt: emailLog.sentAt,
      createdAt: emailLog.createdAt,
      participantId: emailLog.participantId,
      firstName: participants.firstName,
      lastName: participants.lastName,
      submissionId: emailLog.submissionId,
      submissionRef: submissions.ref,
      submissionTitle: submissions.title,
    })
    .from(emailLog)
    .leftJoin(participants, eq(emailLog.participantId, participants.id))
    .leftJoin(submissions, eq(emailLog.submissionId, submissions.id))
    .where(and(eq(emailLog.id, params.id!), eq(emailLog.eventId, DEMO_EVENT_ID)))
    .then((r) => r[0]);

  if (!row) throw new Response("Email not found", { status: 404 });

  const template = await db.query.emailTemplates.findFirst({
    where: and(
      eq(emailTemplates.eventId, DEMO_EVENT_ID),
      eq(emailTemplates.key, row.templateKey),
    ),
  });

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  /* A kept link is only worth offering while it still works, and the
     token row already knows: it is burned on first use and it expires.
     Reading it here means the page says "already used" rather than
     handing over a link that will bounce the speaker back to the
     sign-in form with no explanation. */
  let recovery: {
    url: string;
    state: "live" | "used" | "expired";
    expiresAt: number;
  } | null = null;

  if (row.recoveryLink) {
    const token = new URL(
      row.recoveryLink,
      "http://placeholder.invalid",
    ).searchParams.get("token");
    const tokenRow = token
      ? await db.query.authTokens.findFirst({
          where: eq(authTokens.token, token),
        })
      : null;
    if (tokenRow) {
      const expiresAt = new Date(tokenRow.expiresAt).getTime();
      recovery = {
        url: row.recoveryLink,
        state: tokenRow.usedAt
          ? "used"
          : expiresAt < Date.now()
            ? "expired"
            : "live",
        expiresAt,
      };
    }
  }

  return {
    recovery,
    row: {
      ...row,
      recipientName:
        [row.firstName, row.lastName].filter(Boolean).join(" ") || row.toEmail,
      sentAt: row.sentAt ? new Date(row.sentAt).getTime() : null,
      createdAt: new Date(row.createdAt).getTime(),
    },
    templateName: template?.name ?? null,
    eventZone: safeZone(event?.timezone),
    ms: Date.now() - started,
  };
}

const STATUS_PILL: Record<string, string> = {
  sent: "cb-pill-success",
  queued: "cb-pill-warn",
  failed: "cb-pill-danger",
};

export default function EmailDetail() {
  const { row, recovery, templateName, eventZone, ms } =
    useLoaderData<typeof loader>();

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <Link
              to="/admin/emails"
              className="text-[12px] text-dim underline-offset-2 hover:underline"
            >
              Emails
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <h1 className="text-[19px] font-semibold tracking-tight">
                {row.subject}
              </h1>
              <span className={`cb-pill ${STATUS_PILL[row.status] ?? "cb-pill-neutral"}`}>
                {row.status}
              </span>
            </div>
          </div>
          <div
            className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim"
            title="Server render time for this page"
          >
            {ms} ms
          </div>
        </div>
      </div>

      <div className="grid gap-4 px-6 py-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          {recovery && (
            <section
              className={`cb-note ${recovery.state === "live" ? "cb-note-accent" : "cb-note-warn"} px-4 py-3`}
            >
              <h2 className="text-[13px] font-semibold">
                Sign-in link kept from this failed send
              </h2>
              <p className="mb-2 mt-0.5 text-[12px]">
                {recovery.state === "live" ? (
                  <>
                    This mail never reached the inbox, so the link it carried
                    is here instead. It still works once, until{" "}
                    {fmtWhenIn(recovery.expiresAt, eventZone)}. Send it to{" "}
                    {row.toEmail} another way, and to nobody else: whoever
                    opens it is signed in as them.
                  </>
                ) : recovery.state === "used" ? (
                  <>
                    Already used, so it will not sign anyone in again. If they
                    still need access, mint a fresh one from their{" "}
                    <Link
                      to={`/admin/people/${row.participantId}`}
                      className="underline underline-offset-2"
                    >
                      person page
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    Expired on {fmtWhenIn(recovery.expiresAt, eventZone)} and
                    will not sign anyone in. Mint a fresh one from their{" "}
                    <Link
                      to={`/admin/people/${row.participantId}`}
                      className="underline underline-offset-2"
                    >
                      person page
                    </Link>
                    .
                  </>
                )}
              </p>
              {recovery.state === "live" && <CopyLine text={recovery.url} />}
            </section>
          )}

          <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Body</h2>
            {row.bodyHtml ? (
              <>
                <p className="mt-0.5 text-[12px] text-dim">
                  Exactly what was sent, with merge fields already filled in.
                </p>
                <div className="mt-2">
                  <BodyFrame html={row.bodyHtml} title="Sent message" />
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12px] text-dim hover:text-strong">
                    Source
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-subtle p-3 font-mono text-[11px] leading-relaxed text-body">
                    {row.bodyHtml}
                  </pre>
                </details>
              </>
            ) : (
              <p className="mt-2 text-[13px] text-dim">
                This send predates the log keeping bodies, so only the subject
                and the outcome were recorded. Anything sent from now on keeps
                its body.
              </p>
            )}

            {row.error && (
              <div className="mt-4">
                <h2 className="text-[13px] font-semibold text-danger">
                  Provider error
                </h2>
                <pre className="mt-1 overflow-x-auto rounded-md border border-danger-ring bg-danger-soft p-3 font-mono text-[11px] leading-relaxed text-danger">
                  {row.error}
                </pre>
              </div>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Delivery</h2>
            <dl className="mt-2 space-y-1.5 text-[13px]">
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-dim">To</dt>
                <dd className="min-w-0 break-all text-strong">
                  {row.participantId ? (
                    <Link
                      to={`/admin/people/${row.participantId}`}
                      className="text-accent-text underline-offset-2 hover:underline"
                    >
                      {row.recipientName}
                    </Link>
                  ) : (
                    row.recipientName
                  )}
                  <div className="text-[12px] text-dim">{row.toEmail}</div>
                </dd>
              </div>
              {[
                [
                  "Template",
                  templateName ??
                    (row.templateKey === ONE_OFF_KEY
                      ? "One-off, written by hand"
                      : row.templateKey),
                ],
                ["Template key", row.templateKey],
                [
                  "Sent",
                  row.sentAt
                    ? fmtWhenIn(row.sentAt, eventZone)
                    : "Not delivered",
                ],
                ["Logged", fmtWhenIn(row.createdAt, eventZone)],
                // Only meaningful when an invite was actually attached:
                // the column defaults to 0 on every other row.
                ["ICS sequence", row.icsUid ? String(row.icsSequence ?? 0) : null],
                ["ICS UID", row.icsUid],
              ].map(([label, value]) => (
                <div key={label as string} className="flex gap-3">
                  <dt className="w-24 shrink-0 text-dim">{label}</dt>
                  <dd className="min-w-0 break-all text-strong">
                    {value || <span className="text-faint">Not set</span>}
                  </dd>
                </div>
              ))}
            </dl>
            {row.icsUid && (
              <p className="mt-2 text-[12px] text-dim">
                Sequence {row.icsSequence ?? 0} means a calendar client treats
                this as{" "}
                {(row.icsSequence ?? 0) === 0
                  ? "a new invitation"
                  : "an update to the invitation it already has, rather than a second entry"}
                .
              </p>
            )}
          </section>

          {row.submissionId && (
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-[13px] font-semibold">About</h2>
              <p className="mt-2 text-[13px]">
                <span className="font-mono text-[12px] text-faint">
                  {row.submissionRef}
                </span>{" "}
                <Link
                  to={`/admin/submissions/${row.submissionId}`}
                  className="text-accent-text underline-offset-2 hover:underline"
                >
                  {row.submissionTitle || "Untitled"}
                </Link>
              </p>
            </section>
          )}

          {row.participantId && (
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-[13px] font-semibold">Write again</h2>
              <Link
                to={`/admin/emails?compose=1&to=${row.participantId}`}
                className="cb-btn cb-btn-secondary mt-2 inline-block px-2.5 py-1.5 text-[13px]"
              >
                Compose to {row.recipientName}
              </Link>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
