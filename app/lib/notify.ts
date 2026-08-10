/* ------------------------------------------------------------------ *
 * Submission confirmation.
 *
 * Called from the public form and from the API POST, through one
 * implementation, so a submission made either way produces the same
 * email and the same log row.
 *
 * Never throws. A submission that is safely stored must not be reported
 * as failed because a mail provider was slow, so every failure here is
 * recorded and swallowed.
 * ------------------------------------------------------------------ */

import { and, eq } from "drizzle-orm";
import {
  authTokens,
  emailLog,
  emailTemplates,
  events,
  forms,
  participants,
  submissions,
} from "~/db/schema";
import { render, sendEmail } from "~/lib/email";
import type { getDb } from "~/db/client";

type Db = ReturnType<typeof getDb>;

/* Longer than the 30 minutes a sign-in link gets. A confirmation is
   frequently opened the next morning, and a link that is already dead on
   first click just generates support mail. Still single use, still
   scoped to one participant, and the expiry is stated in the body. */
export const CONFIRMATION_LINK_TTL_HOURS = 72;

export const DEFAULT_SUBMISSION_CONFIRMATION = {
  subject: "We have your submission: {{submission.title}}",
  bodyHtml:
    "<p>Hi {{participant.firstName}},</p>" +
    "<p>Thanks for submitting <strong>{{submission.title}}</strong> to {{event.name}}.</p>" +
    "<p>Your reference is <strong>{{submission.ref}}</strong>. Quote it if you need to get in touch about this proposal.</p>" +
    '<p><a href="{{magicLinkUrl}}">Open your speaker portal</a> to review or update it. That link signs you in directly and works once, for {{expiresInHours}} hours. After that you can request a new one at {{portalUrl}}.</p>',
};

export type ConfirmationResult =
  | { sent: true; simulated: boolean; to: string }
  | { sent: false; reason: string };

export async function sendSubmissionConfirmation(
  db: Db,
  env: Env,
  opts: { submissionId: string; participantId: string; origin: string },
): Promise<ConfirmationResult> {
  try {
    const submission = await db.query.submissions.findFirst({
      where: eq(submissions.id, opts.submissionId),
    });
    if (!submission) return { sent: false, reason: "submission not found" };

    // The toggle lives on the form, so an organiser running a quiet
    // internal call can turn acknowledgements off for that form alone.
    const form = submission.formId
      ? await db.query.forms.findFirst({ where: eq(forms.id, submission.formId) })
      : null;
    if (form && !form.confirmSubmitter) {
      return { sent: false, reason: "disabled for this form" };
    }

    const person = await db.query.participants.findFirst({
      where: eq(participants.id, opts.participantId),
    });
    if (!person?.email) return { sent: false, reason: "no email on file" };

    const event = await db.query.events.findFirst({
      where: eq(events.id, submission.eventId),
    });

    const token = crypto.randomUUID().replace(/-/g, "");
    await db.insert(authTokens).values({
      participantId: person.id,
      token,
      expiresAt: new Date(
        Date.now() + CONFIRMATION_LINK_TTL_HOURS * 60 * 60_000,
      ),
    });

    const tpl = await db.query.emailTemplates.findFirst({
      where: and(
        eq(emailTemplates.eventId, submission.eventId),
        eq(emailTemplates.key, "submission_confirmation"),
      ),
    });

    // A template row that exists but is switched off is an explicit
    // choice, and outranks the form level default.
    if (tpl && !tpl.enabled) {
      return { sent: false, reason: "template disabled" };
    }

    const vars: Record<string, string> = {
      "participant.firstName": person.firstName ?? "there",
      "participant.lastName": person.lastName ?? "",
      "event.name": event?.name ?? "the event",
      "submission.title": submission.title || "your submission",
      "submission.ref": submission.ref,
      "form.closeAt": form?.closeAt
        ? new Date(form.closeAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : "the deadline",
      magicLinkUrl: `${opts.origin}/portal?token=${token}`,
      portalUrl: `${opts.origin}/portal`,
      expiresInHours: String(CONFIRMATION_LINK_TTL_HOURS),
    };

    const subject = render(
      tpl?.subject ?? DEFAULT_SUBMISSION_CONFIRMATION.subject,
      vars,
    );
    const html = render(
      tpl?.bodyHtml ?? DEFAULT_SUBMISSION_CONFIRMATION.bodyHtml,
      vars,
    );

    const result = await sendEmail(env, { to: person.email, subject, html });

    await db.insert(emailLog).values({
      eventId: submission.eventId,
      participantId: person.id,
      submissionId: submission.id,
      templateKey: "submission_confirmation",
      toEmail: person.email,
      subject,
      status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
      error: result.error ?? null,
      sentAt: result.ok && !result.simulated ? new Date() : null,
    });

    if (!result.ok) {
      console.error(
        "submission confirmation failed for",
        submission.ref,
        result.error,
      );
      return { sent: false, reason: result.error ?? "send failed" };
    }

    return { sent: true, simulated: result.simulated, to: person.email };
  } catch (e) {
    console.error("submission confirmation threw for", opts.submissionId, e);
    return { sent: false, reason: String(e).slice(0, 200) };
  }
}
