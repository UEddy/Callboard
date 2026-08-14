/* ------------------------------------------------------------------ *
 * The one-off send, and what merge fields mean.
 *
 * Every automated email in Callboard already renders a template against
 * a bag of variables and writes a row to the log. The composer does the
 * same thing with a producer at the keyboard instead of a trigger, and
 * goes through this module so a hand-written mail is logged exactly like
 * an acceptance: same status vocabulary, same body kept, same place to
 * look when somebody says they never got it.
 * ------------------------------------------------------------------ */

import { and, eq, inArray } from "drizzle-orm";
import { emailLog, participants } from "~/db/schema";
import { render, sendEmail } from "~/lib/email";
import { fmtWhenIn, safeZone } from "~/lib/tz";
import { mintSignInLink } from "~/lib/people";
import type { getDb } from "~/db/client";

type Db = ReturnType<typeof getDb>;

/* What the log calls a mail nobody templated. Reads as a template key
   everywhere the log groups by one, rather than an empty cell. */
export const ONE_OFF_KEY = "one_off";

export type MergeField = { key: string; description: string };

export const MERGE_FIELDS: MergeField[] = [
  { key: "participant.firstName", description: "First name, or “there” when blank" },
  { key: "participant.lastName", description: "Last name" },
  { key: "participant.fullName", description: "Both names, or the address when neither is set" },
  { key: "participant.email", description: "Their address" },
  { key: "participant.company", description: "Company" },
  { key: "participant.jobTitle", description: "Job title" },
  { key: "event.name", description: "This event's name" },
  { key: "event.location", description: "Where it happens" },
  { key: "event.startsAt", description: "When it starts, in the event's timezone" },
  { key: "portalUrl", description: "The speaker portal sign-in page" },
  {
    key: "magicLinkUrl",
    description:
      "A one-time sign-in link, minted per recipient at send time. Only used when you put it in the body.",
  },
];

export type Recipient = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
};

export type EventBits = {
  name: string;
  location: string | null;
  startsAt: Date | number | null;
  timezone: string | null;
};

/* Preview mints nothing: a token handed out for a mail that was never
   sent is a live way into somebody's portal sitting in a page nobody
   read. The placeholder says what the real one will look like. */
export const PREVIEW_TOKEN_NOTE = "one-time-token-minted-at-send";

export function mergeVars(
  person: Recipient,
  event: EventBits | null | undefined,
  origin: string,
  magicLinkUrl: string,
): Record<string, string> {
  const zone = safeZone(event?.timezone);
  const startsAt = event?.startsAt ? new Date(event.startsAt).getTime() : null;
  return {
    "participant.firstName": person.firstName ?? "there",
    "participant.lastName": person.lastName ?? "",
    "participant.fullName":
      [person.firstName, person.lastName].filter(Boolean).join(" ") ||
      person.email,
    "participant.email": person.email,
    "participant.company": person.company ?? "",
    "participant.jobTitle": person.jobTitle ?? "",
    "event.name": event?.name ?? "the event",
    "event.location": event?.location ?? "",
    "event.startsAt": startsAt ? fmtWhenIn(startsAt, zone) : "",
    portalUrl: `${origin}/portal`,
    magicLinkUrl,
  };
}

export function usesMagicLink(...parts: string[]) {
  return parts.some((p) => p.includes("{{magicLinkUrl}}"));
}

/* Templates written for a trigger know things a hand-written mail does
   not: which submission, which room. Loading the acceptance template
   into the composer is a reasonable thing to do, and those fields
   quietly emptying is not, so they are named before anything is sent.
   The {{#room}} sections are worse than empty: nothing substitutes them
   at all, so they would reach the recipient as literal text. */
export function unsupportedFields(...parts: string[]): string[] {
  const known = new Set(MERGE_FIELDS.map((f) => f.key));
  const found = new Set<string>();
  for (const part of parts) {
    for (const m of part.matchAll(/\{\{([^}]+)\}\}/g)) {
      const token = m[1].trim();
      if (/^[#/]/.test(token) || !known.has(token)) found.add(`{{${token}}}`);
    }
  }
  return [...found];
}

/* Renders for one person and previews the result without sending. */
export function renderFor(
  person: Recipient,
  event: EventBits | null | undefined,
  origin: string,
  subject: string,
  bodyHtml: string,
) {
  const vars = mergeVars(
    person,
    event,
    origin,
    `${origin}/portal?token=${PREVIEW_TOKEN_NOTE}`,
  );
  return {
    subject: render(subject, vars),
    bodyHtml: render(bodyHtml, vars),
  };
}

export type SendSummary = {
  sent: number;
  simulated: number;
  failed: number;
  firstError: string | null;
};

/* Sends to everybody and logs every attempt, including the ones that
   fail. A partial failure is reported as itself rather than rolled up
   into "something went wrong": the producer needs to know which three
   of forty bounced. */
export async function sendToRecipients(
  db: Db,
  env: Env,
  opts: {
    eventId: string;
    event: EventBits | null | undefined;
    origin: string;
    recipients: Recipient[];
    subject: string;
    bodyHtml: string;
    templateKey: string;
  },
): Promise<SendSummary> {
  const summary: SendSummary = {
    sent: 0,
    simulated: 0,
    failed: 0,
    firstError: null,
  };
  const needsLink = usesMagicLink(opts.subject, opts.bodyHtml);

  for (const person of opts.recipients) {
    const magicLinkUrl = needsLink
      ? await mintSignInLink(db, person.id, opts.origin)
      : "";
    const vars = mergeVars(person, opts.event, opts.origin, magicLinkUrl);
    const subject = render(opts.subject, vars);
    const html = render(opts.bodyHtml, vars);

    const result = await sendEmail(env, { to: person.email, subject, html });

    if (!result.ok) {
      summary.failed++;
      summary.firstError ??= result.error ?? "send failed";
    } else if (result.simulated) summary.simulated++;
    else summary.sent++;

    await db.insert(emailLog).values({
      eventId: opts.eventId,
      participantId: person.id,
      templateKey: opts.templateKey,
      toEmail: person.email,
      subject,
      bodyHtml: html,
      status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
      error: result.error ?? null,
      // A composed mail only carries a link when the author asked for
      // one, and only a failed send needs it kept.
      recoveryLink: !result.ok && magicLinkUrl ? magicLinkUrl : null,
      sentAt: result.ok && !result.simulated ? new Date() : null,
    });
  }

  return summary;
}

/* The chosen recipients, scoped to this event so an id typed into the
   form cannot address somebody on another one. Returned in the order
   they were picked, because the first of them is who the preview is
   rendered for. */
export async function loadRecipients(
  db: Db,
  eventId: string,
  ids: string[],
): Promise<Recipient[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];

  const rows = await db
    .select({
      id: participants.id,
      email: participants.email,
      firstName: participants.firstName,
      lastName: participants.lastName,
      company: participants.company,
      jobTitle: participants.jobTitle,
    })
    .from(participants)
    .where(
      and(eq(participants.eventId, eventId), inArray(participants.id, unique)),
    );

  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => byId.get(id)).filter(Boolean) as Recipient[];
}

/* ------------------------------------------------------------------ *
 * Delivery health.
 *
 * A provider error arrives as whatever JSON that provider felt like
 * returning. An organiser should not have to read it: they need one
 * sentence telling them whether mail is working, and if it is not, why
 * not, in words.
 * ------------------------------------------------------------------ */

export const HEALTH_WINDOW_DAYS = 7;

/* Pulls the human part out of a provider's error payload. Resend
   answers with {"statusCode":403,"name":"validation_error","message":
   "..."}; the message is the only bit worth showing. */
export function describeFailure(error: string | null): string {
  const raw = (error ?? "").trim();
  if (!raw) return "No reason was recorded.";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : null;
    if (message) return message.replace(/\s+/g, " ").trim();
  } catch {
    // Not JSON. Whatever it is, it is what we have.
  }
  return raw.replace(/\s+/g, " ").slice(0, 240);
}

export type DeliveryHealth = {
  sent: number;
  failed: number;
  queued: number;
  total: number;
  windowDays: number;
  lastFailure: {
    id: string;
    toEmail: string;
    subject: string;
    reason: string;
    at: number;
  } | null;
};

export function summariseHealth(
  rows: {
    id: string;
    status: string;
    error: string | null;
    toEmail: string;
    subject: string;
    createdAt: Date | number;
    sentAt: Date | number | null;
  }[],
): DeliveryHealth {
  const health: DeliveryHealth = {
    sent: 0,
    failed: 0,
    queued: 0,
    total: rows.length,
    windowDays: HEALTH_WINDOW_DAYS,
    lastFailure: null,
  };

  for (const r of rows) {
    if (r.status === "sent") health.sent++;
    else if (r.status === "failed") health.failed++;
    else health.queued++;

    if (r.status !== "failed") continue;
    const at = new Date(r.sentAt ?? r.createdAt).getTime();
    if (!health.lastFailure || at > health.lastFailure.at) {
      health.lastFailure = {
        id: r.id,
        toEmail: r.toEmail,
        subject: r.subject,
        reason: describeFailure(r.error),
        at,
      };
    }
  }

  return health;
}

export function describeSend(summary: SendSummary): string {
  const bits: string[] = [];
  if (summary.sent) bits.push(`${summary.sent} sent`);
  if (summary.simulated) {
    bits.push(
      `${summary.simulated} logged but not delivered, because no mail provider is configured`,
    );
  }
  if (summary.failed) bits.push(`${summary.failed} failed`);
  const head = bits.length ? bits.join(", ") : "Nothing to send";
  return summary.firstError
    ? `${head}. First error: ${summary.firstError.slice(0, 200)}`
    : `${head}.`;
}
