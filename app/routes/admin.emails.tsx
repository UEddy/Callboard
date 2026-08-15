import { useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, desc, eq, gte, like, or, sql } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  emailLog,
  emailTemplates,
  events,
  participants,
  rooms,
  submissionParticipants,
  submissions,
} from "~/db/schema";
import {
  HEALTH_WINDOW_DAYS,
  MERGE_FIELDS,
  ONE_OFF_KEY,
  describeFailure,
  describeSend,
  loadRecipients,
  mergeVars,
  renderFor,
  sendToRecipients,
  summariseHealth,
  unsupportedFields,
  type DeliveryHealth,
} from "~/lib/emails";
import { render, sendEmail } from "~/lib/email";
import { RECIPIENT_GROUPS, loadRecipientOptions } from "~/lib/people";
import { BodyFrame } from "~/components/EmailBody";
import { fmtDateIn, fmtWhenIn, safeZone } from "~/lib/tz";
import { publicBaseUrl } from "~/lib/base-url";

/* ------------------------------------------------------------------ *
 * Every email this event has sent, and the one place to send another.
 *
 * The log is the answer to "did they get it", which is the question
 * that arrives the week of the show, so it holds what was actually
 * sent: the merged subject, the merged body, the provider's error text
 * and the calendar sequence that says whether an invite updated an
 * existing entry or made a second one.
 *
 * The composer writes to the same log. A mail typed by hand is not a
 * special case, and a producer should never have to remember which of
 * their sends are on the record.
 * ------------------------------------------------------------------ */

const LIMIT = 200;

const STATUSES = [
  { key: "", label: "Any status" },
  { key: "sent", label: "Sent" },
  { key: "queued", label: "Queued" },
  { key: "failed", label: "Failed" },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);

  const q = (url.searchParams.get("q") ?? "").trim();
  const template = url.searchParams.get("template") ?? "";
  const status = url.searchParams.get("status") ?? "";
  const composing = url.searchParams.get("compose") === "1";

  const term = `%${q}%`;
  const where = and(
    eq(emailLog.eventId, DEMO_EVENT_ID),
    template ? eq(emailLog.templateKey, template) : undefined,
    status ? eq(emailLog.status, status) : undefined,
    q
      ? or(
          like(emailLog.toEmail, term),
          like(emailLog.subject, term),
          like(participants.firstName, term),
          like(participants.lastName, term),
        )
      : undefined,
  );

  const rowsQ = db
    .select({
      id: emailLog.id,
      toEmail: emailLog.toEmail,
      subject: emailLog.subject,
      templateKey: emailLog.templateKey,
      status: emailLog.status,
      error: emailLog.error,
      recoveryLink: emailLog.recoveryLink,
      icsSequence: emailLog.icsSequence,
      icsUid: emailLog.icsUid,
      sentAt: emailLog.sentAt,
      createdAt: emailLog.createdAt,
      participantId: emailLog.participantId,
      firstName: participants.firstName,
      lastName: participants.lastName,
    })
    .from(emailLog)
    .leftJoin(participants, eq(emailLog.participantId, participants.id))
    .where(where)
    .orderBy(desc(emailLog.createdAt))
    .limit(LIMIT);

  // Every key the log actually holds, so the filter cannot offer a
  // template that has never been used, or hide one whose row was
  // deleted from the templates table.
  const usedKeysQ = db
    .select({
      key: emailLog.templateKey,
      n: sql<number>`count(*)`,
    })
    .from(emailLog)
    .where(eq(emailLog.eventId, DEMO_EVENT_ID))
    .groupBy(emailLog.templateKey);

  const statusCountsQ = db
    .select({ status: emailLog.status, n: sql<number>`count(*)` })
    .from(emailLog)
    .where(eq(emailLog.eventId, DEMO_EVENT_ID))
    .groupBy(emailLog.status);

  const templatesQ = db
    .select({
      id: emailTemplates.id,
      key: emailTemplates.key,
      name: emailTemplates.name,
      subject: emailTemplates.subject,
      bodyHtml: emailTemplates.bodyHtml,
      enabled: emailTemplates.enabled,
    })
    .from(emailTemplates)
    .where(eq(emailTemplates.eventId, DEMO_EVENT_ID));

  const eventQ = db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  /* Delivery health over a rolling week. Counted from the log rather
     than from the provider, because the log is the thing that survives
     the provider changing its mind about its API. */
  const since = new Date(Date.now() - HEALTH_WINDOW_DAYS * 86_400_000);
  const healthQ = db
      .select({
        id: emailLog.id,
        status: emailLog.status,
        error: emailLog.error,
        toEmail: emailLog.toEmail,
        subject: emailLog.subject,
        createdAt: emailLog.createdAt,
        sentAt: emailLog.sentAt,
      })
      .from(emailLog)
      .where(
        and(eq(emailLog.eventId, DEMO_EVENT_ID), gte(emailLog.createdAt, since)),
      );

  /* Six reads, none of which needs anything from another, so they wait
     together rather than in turn. */
  const [rows, usedKeys, statusCounts, templates, event, healthRows] =
    await Promise.all([
      rowsQ,
      usedKeysQ,
      statusCountsQ,
      templatesQ,
      eventQ,
      healthQ,
    ]);

  const health = summariseHealth(healthRows);

  const env = context.get(cloudflareContext).env as unknown as {
    RESEND_API_KEY?: string;
  };

  return {
    rows: rows.map((r) => ({
      ...r,
      name: [r.firstName, r.lastName].filter(Boolean).join(" "),
      at: new Date(r.sentAt ?? r.createdAt).getTime(),
    })),
    truncated: rows.length === LIMIT,
    templateOptions: usedKeys
      .map((k) => ({
        key: k.key,
        n: Number(k.n),
        name: templates.find((t) => t.key === k.key)?.name ?? k.key,
      }))
      .sort((a, b) => b.n - a.n),
    statusCounts: Object.fromEntries(
      statusCounts.map((s) => [s.status, Number(s.n)]),
    ) as Record<string, number>,
    health,
    templates,
    recipientOptions: composing ? await loadRecipientOptions(db) : [],
    preselected: composing ? url.searchParams.getAll("to") : [],
    composing,
    mailConfigured: Boolean(env.RESEND_API_KEY),
    eventZone: safeZone(event?.timezone),
    q,
    template,
    status,
    ms: Date.now() - started,
  };
}

type Draft = {
  recipientIds: string[];
  templateKey: string;
  subject: string;
  bodyHtml: string;
};

function readDraft(fd: FormData): Draft {
  return {
    recipientIds: (fd.getAll("recipientIds") as string[]).filter(Boolean),
    templateKey: String(fd.get("templateKey") ?? ""),
    subject: String(fd.get("subject") ?? ""),
    bodyHtml: String(fd.get("bodyHtml") ?? ""),
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const env = context.get(cloudflareContext).env;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");
  const origin = publicBaseUrl(context.get(cloudflareContext).env, request);

  const draft = readDraft(fd);

  const templates = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.eventId, DEMO_EVENT_ID));
  const chosen = templates.find((t) => t.key === draft.templateKey);

  /* Loading a template overwrites the boxes on purpose: you asked for
     the template, so you get the template, and anything you had typed
     was a draft you chose to replace. */
  if (intent === "load_template") {
    if (!chosen) {
      return {
        draft,
        error: "Pick a template first, or write a one-off below.",
      };
    }
    return {
      draft: {
        ...draft,
        subject: chosen.subject,
        bodyHtml: chosen.bodyHtml,
      },
      unsupported: unsupportedFields(chosen.subject, chosen.bodyHtml),
      note: `Loaded "${chosen.name}". Edit it here if you like: this send does not change the saved template.`,
    };
  }

  /* --- Send test email ---------------------------------------------- *
   *
   * The point is to prove delivery works before an event depends on it,
   * so it goes through the same sendEmail and lands in the same log as
   * everything else. The merge fields are filled from a real submission
   * rather than from "Sample Speaker", because half of what an organiser
   * is checking is whether the template reads right with actual names in
   * it.
   * ------------------------------------------------------------------ */
  if (intent === "send_test") {
    const to = String(fd.get("testTo") ?? "").trim();
    const key = String(fd.get("testTemplateKey") ?? "");

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return { testError: `"${to || "That"}" is not an email address.` };
    }

    const tpl = templates.find((t) => t.key === key);
    if (!tpl) return { testError: "Pick a template to test." };

    const event = await db.query.events.findFirst({
      where: eq(events.id, DEMO_EVENT_ID),
    });
    const zone = safeZone(event?.timezone);

    /* The most recently submitted proposal that has somebody on it: the
       freshest thing an organiser will recognise. */
    const sample = await db
      .select({
        ref: submissions.ref,
        title: submissions.title,
        startsAt: submissions.startsAt,
        roomName: rooms.name,
        firstName: participants.firstName,
        lastName: participants.lastName,
        email: participants.email,
        company: participants.company,
        jobTitle: participants.jobTitle,
        participantId: participants.id,
      })
      .from(submissions)
      .innerJoin(
        submissionParticipants,
        eq(submissionParticipants.submissionId, submissions.id),
      )
      .innerJoin(
        participants,
        eq(submissionParticipants.participantId, participants.id),
      )
      .leftJoin(rooms, eq(submissions.roomId, rooms.id))
      .where(eq(submissions.eventId, DEMO_EVENT_ID))
      .orderBy(desc(submissions.refSeq))
      .limit(1)
      .then((r) => r[0]);

    const person = sample
      ? {
          id: sample.participantId,
          email: sample.email,
          firstName: sample.firstName,
          lastName: sample.lastName,
          company: sample.company,
          jobTitle: sample.jobTitle,
        }
      : {
          id: "",
          email: to,
          firstName: "there",
          lastName: "",
          company: null,
          jobTitle: null,
        };

    /* No token is minted for a test. A magic link is a way into that
       speaker's portal, and this is going to whatever address the
       organiser typed, which is not theirs. The link lands on the
       sign-in page instead. */
    const vars: Record<string, string> = {
      ...mergeVars(person, event, origin, `${origin}/portal`),
      "submission.title": sample?.title ?? "A sample submission",
      "submission.ref": sample?.ref ?? "SAMPLE-1",
      "submission.startsAt": fmtWhenIn(
        sample?.startsAt ? new Date(sample.startsAt).getTime() : null,
        zone,
      ),
      "room.name": sample?.roomName ?? "",
      "form.closeAt": fmtDateIn(Date.now(), zone, {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
      openTaskCount: "2",
      taskList: "<ul><li>Upload your headshot</li><li>Upload your slides</li></ul>",
      expiresInHours: "72",
      expiresInMinutes: "30",
    };

    const subject = `[Test] ${render(tpl.subject, vars)}`;
    /* The {{#room}} sections are the acceptance template's, and a test
       that left them as literal text would look broken rather than
       tested. Same substitution the decisions screen does. */
    const html = render(tpl.bodyHtml, vars).replace(
      /\{\{#room\}\}(.*?)\{\{\/room\}\}/gs,
      (_, inner: string) => (vars["room.name"] ? render(inner, vars) : ""),
    );

    const result = await sendEmail(env, { to, subject, html });

    await db.insert(emailLog).values({
      eventId: DEMO_EVENT_ID,
      // Not attributed to the sample speaker: they did not receive it.
      participantId: null,
      templateKey: tpl.key,
      toEmail: to,
      subject,
      bodyHtml: html,
      status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
      error: result.error ?? null,
      sentAt: result.ok && !result.simulated ? new Date() : null,
    });

    if (!result.ok) {
      return {
        testError: `The provider refused it: ${describeFailure(result.error ?? null)}`,
      };
    }
    return {
      testSent: result.simulated
        ? `Logged a test of "${tpl.name}" to ${to}, but no mail provider is configured so nothing left the building.`
        : `Sent a test of "${tpl.name}" to ${to}, merged from ${sample?.ref ?? "sample data"}. It is on the log below.`,
    };
  }

  if (intent !== "preview" && intent !== "send") {
    return { draft, error: "Unknown action." };
  }

  /* An empty box with a template selected means "just send the
     template", which is the common case for a reminder. */
  const subject = draft.subject.trim() || chosen?.subject || "";
  const bodyHtml = draft.bodyHtml.trim() || chosen?.bodyHtml || "";
  const filled: Draft = { ...draft, subject, bodyHtml };

  const recipients = await loadRecipients(db, DEMO_EVENT_ID, draft.recipientIds);

  if (!recipients.length) {
    return { draft: filled, error: "Pick at least one recipient." };
  }
  if (!subject.trim()) {
    return { draft: filled, error: "The subject is empty." };
  }
  if (!bodyHtml.trim()) {
    return { draft: filled, error: "The body is empty." };
  }

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  const unsupported = unsupportedFields(subject, bodyHtml);

  if (intent === "preview") {
    const first = recipients[0];
    const rendered = renderFor(first, event, origin, subject, bodyHtml);
    return {
      draft: filled,
      unsupported,
      preview: {
        to: first.email,
        name: [first.firstName, first.lastName].filter(Boolean).join(" ") ||
          first.email,
        subject: rendered.subject,
        bodyHtml: rendered.bodyHtml,
        others: recipients.length - 1,
      },
    };
  }

  const summary = await sendToRecipients(db, env, {
    eventId: DEMO_EVENT_ID,
    event,
    origin,
    recipients,
    subject,
    bodyHtml,
    templateKey: chosen?.key ?? ONE_OFF_KEY,
  });

  return {
    draft: filled,
    unsupported,
    sent: describeSend(summary),
    failed: summary.failed > 0,
  };
}

/* --- UI --------------------------------------------------------------- */

const control =
  "rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong outline-none focus:border-accent-solid focus:ring-2 focus:ring-accent-ring";
const field = `mt-1 w-full ${control}`;

const STATUS_PILL: Record<string, string> = {
  sent: "cb-pill-success",
  queued: "cb-pill-warn",
  failed: "cb-pill-danger",
};

export default function Emails() {
  const {
    rows,
    truncated,
    templateOptions,
    statusCounts,
    templates,
    health,
    recipientOptions,
    preselected,
    composing,
    mailConfigured,
    eventZone,
    q,
    template,
    status,
    ms,
  } = useLoaderData<typeof loader>();
  const action = useActionData<{
    draft?: Draft;
    error?: string;
    note?: string;
    sent?: string;
    failed?: boolean;
    unsupported?: string[];
    testSent?: string;
    testError?: string;
    preview?: {
      to: string;
      name: string;
      subject: string;
      bodyHtml: string;
      others: number;
    };
  }>();
  const nav = useNavigation();
  const navigate = useNavigate();
  const busy = nav.state !== "idle";
  const [params] = useSearchParams();

  const composeHref = () => {
    const next = new URLSearchParams(params);
    next.set("compose", "1");
    return `?${next}`;
  };
  const closeComposeHref = () => {
    const next = new URLSearchParams(params);
    next.delete("compose");
    next.delete("to");
    return `?${next}` === "?" ? "/admin/emails" : `?${next}`;
  };

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Emails</h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Everything this event has sent, and what happened to it.
              {!mailConfigured && (
                <>
                  {" "}
                  No mail provider is configured, so sends are logged as{" "}
                  <span className="font-medium">queued</span> and nothing leaves
                  the building.
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {composing ? (
              <Link
                to={closeComposeHref()}
                className="cb-btn cb-btn-secondary px-2.5 py-1.5 text-[13px]"
              >
                Close composer
              </Link>
            ) : (
              <Link
                to={composeHref()}
                className="cb-btn cb-btn-primary px-2.5 py-1.5 text-[13px]"
              >
                Compose
              </Link>
            )}
            <div
              className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim"
              title="Server render time for this page"
            >
              {ms} ms
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-dim">
          {["sent", "queued", "failed"].map((s) => (
            <span key={s}>
              <span
                className={[
                  "font-semibold tabular-nums",
                  s === "failed" && (statusCounts[s] ?? 0) > 0
                    ? "text-danger"
                    : "text-strong",
                ].join(" ")}
              >
                {statusCounts[s] ?? 0}
              </span>{" "}
              {s}
            </span>
          ))}
          <span className="text-faint">all time</span>
        </div>
      </div>

      <DeliveryHealthPanel
        health={health}
        templates={templates}
        mailConfigured={mailConfigured}
        eventZone={eventZone}
        busy={busy}
        testSent={action?.testSent}
        testError={action?.testError}
      />

      {composing && (
        <Composer
          templates={templates}
          recipientOptions={recipientOptions}
          preselected={action?.draft?.recipientIds ?? preselected}
          draft={action?.draft}
          preview={action?.preview}
          error={action?.error}
          note={action?.note}
          sent={action?.sent}
          failed={action?.failed}
          unsupported={action?.unsupported ?? []}
          busy={busy}
          mailConfigured={mailConfigured}
        />
      )}

      <Form
        method="get"
        action="/admin/emails"
        className="flex flex-wrap items-center gap-2 px-6 py-3"
      >
        {composing && <input type="hidden" name="compose" value="1" />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search recipient or subject"
          className={`${control} w-64 placeholder:text-faint`}
        />
        <select name="template" defaultValue={template} className={control}>
          <option value="">Any template</option>
          {templateOptions.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name} ({t.n})
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status} className={control}>
          {STATUSES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button type="submit" className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]">
          Apply
        </button>
        {(q || template || status) && (
          <Link
            to={composing ? "/admin/emails?compose=1" : "/admin/emails"}
            className="text-[13px] text-dim underline-offset-2 hover:text-strong hover:underline"
          >
            Clear
          </Link>
        )}
        <span className="ml-auto text-[12px] tabular-nums text-dim">
          {truncated ? `Newest ${LIMIT}` : `${rows.length} shown`}
        </span>
      </Form>

      <div className="px-6 pb-8">
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          {rows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[14px] font-medium text-strong">
                Nothing here
              </p>
              <p className="mt-1 text-[13px] text-dim">
                {q || template || status ? (
                  <>
                    No mail matches those filters.{" "}
                    <Link
                      to="/admin/emails"
                      className="text-accent-text underline underline-offset-2"
                    >
                      Clear them
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    Nothing has been sent yet. Acceptances go out from{" "}
                    <Link
                      to="/admin/decisions"
                      className="text-accent-text underline underline-offset-2"
                    >
                      Decisions
                    </Link>
                    , or write one here.
                  </>
                )}
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="cb-thead text-[11px] uppercase tracking-[0.06em]">
                  <th className="px-4 py-2 font-medium">Recipient</th>
                  <th className="px-4 py-2 font-medium">Subject</th>
                  <th className="px-4 py-2 font-medium">Template</th>
                  <th className="px-4 py-2 font-medium" title="Calendar invite sequence">
                    ICS seq
                  </th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a,button")) return;
                      navigate(`/admin/emails/${r.id}`);
                    }}
                    className="cb-row-hover cursor-pointer border-b border-line-soft last:border-0 align-top"
                  >
                    <td className="px-4 py-2.5">
                      <div className="text-strong">{r.toEmail}</div>
                      {r.name && (
                        <div className="text-[12px] text-dim">
                          {r.participantId ? (
                            <Link
                              to={`/admin/people/${r.participantId}`}
                              className="underline-offset-2 hover:text-strong hover:underline"
                            >
                              {r.name}
                            </Link>
                          ) : (
                            r.name
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/admin/emails/${r.id}`}
                        className="text-strong underline-offset-2 hover:underline"
                      >
                        {r.subject}
                      </Link>
                      {r.error && (
                        <div
                          className="text-[12px] text-danger"
                          title={r.error}
                        >
                          {r.error.slice(0, 120)}
                          {r.error.length > 120 ? "…" : ""}
                        </div>
                      )}
                      {/* The bounce locked somebody out of their portal,
                          and the link that would let them in is on the
                          row. Say so here rather than making a producer
                          open failures one by one to find out. */}
                      {r.recoveryLink && (
                        <Link
                          to={`/admin/emails/${r.id}`}
                          className="text-[12px] font-medium text-accent-text underline-offset-2 hover:underline"
                        >
                          Sign-in link kept, open to copy
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-[12px] text-dim">
                        {r.templateKey}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-dim">
                      {/* Only a mail that actually carried an invite has a
                          sequence worth reading. The column defaults to 0
                          for everything else, which would otherwise read
                          as "first invitation" for a plain reminder. */}
                      {r.icsUid ? (
                        <span
                          title={`${r.icsUid} · ${r.icsSequence === 0 ? "first invitation" : "an update to the invitation already sent"}`}
                        >
                          {r.icsSequence ?? 0}
                        </span>
                      ) : (
                        <span className="text-faint" title="No calendar invite attached">
                          -
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`cb-pill ${STATUS_PILL[r.status] ?? "cb-pill-neutral"}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-dim">
                      {fmtDateIn(r.at, eventZone, {
                        day: "numeric",
                        month: "short",
                      })}
                      {r.sentAt ? "" : " (not sent)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/* --- Delivery health --------------------------------------------------- *
 *
 * The question this answers is "is mail working", and the answer is a
 * sentence, not a table. The counts are there for somebody who wants
 * them, but an organiser should be able to look once and walk away.
 * ------------------------------------------------------------------ */

function DeliveryHealthPanel({
  health,
  templates,
  mailConfigured,
  eventZone,
  busy,
  testSent,
  testError,
}: {
  health: DeliveryHealth;
  templates: { key: string; name: string; enabled: boolean }[];
  mailConfigured: boolean;
  eventZone: string;
  busy: boolean;
  testSent?: string;
  testError?: string;
}) {
  const { sent, failed, queued, total, windowDays, lastFailure } = health;

  const tone = !mailConfigured
    ? "cb-note-warn"
    : failed > 0
      ? "cb-note-danger"
      : sent > 0
        ? "cb-note-success"
        : "cb-note-accent";

  const headline = !mailConfigured
    ? "No mail provider is configured, so nothing is being delivered."
    : total === 0
      ? `Nothing has been sent in the last ${windowDays} days, so there is nothing to judge delivery by. Send a test.`
      : failed === 0
        ? `Mail is working. ${sent} sent in the last ${windowDays} days${queued ? `, ${queued} still queued` : ""}, none failed.`
        : sent === 0
          ? `Mail is not getting through. All ${failed} attempt${failed === 1 ? "" : "s"} in the last ${windowDays} days failed.`
          : `${failed} of ${sent + failed} sends failed in the last ${windowDays} days.`;

  return (
    <div className="border-b border-line bg-subtle px-6 py-3">
      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <div>
          <p className={`cb-note ${tone} px-3 py-2.5 text-[13px]`}>
            {headline}
            {lastFailure && (
              <>
                {" "}
                The most recent failure was to{" "}
                <span className="font-medium">{lastFailure.toEmail}</span> on{" "}
                {fmtDateIn(lastFailure.at, eventZone, {
                  day: "numeric",
                  month: "short",
                })}
                : {lastFailure.reason}{" "}
                <Link
                  to={`/admin/emails/${lastFailure.id}`}
                  className="underline underline-offset-2"
                >
                  Open it
                </Link>
                .
              </>
            )}
          </p>

          <div className="mt-1.5 flex flex-wrap gap-3 px-1 text-[12px] text-dim">
            {[
              ["sent", sent],
              ["queued", queued],
              ["failed", failed],
            ].map(([label, n]) => (
              <span key={label as string}>
                <span
                  className={[
                    "font-semibold tabular-nums",
                    label === "failed" && (n as number) > 0
                      ? "text-danger"
                      : "text-strong",
                  ].join(" ")}
                >
                  {n as number}
                </span>{" "}
                {label as string}
              </span>
            ))}
            <span className="text-faint">last {windowDays} days</span>
          </div>
        </div>

        {/* --- Send test email --- */}
        <Form
          method="post"
          className="rounded-lg border border-line bg-surface p-3"
        >
          <input type="hidden" name="intent" value="send_test" />
          <div className="text-[13px] font-medium text-strong">
            Send test email
          </div>
          <p className="mt-0.5 text-[12px] text-dim">
            One template, to an address you choose, with the merge fields
            filled from a real submission. No sign-in link is minted for a
            test.
          </p>

          <select
            name="testTemplateKey"
            defaultValue={templates[0]?.key ?? ""}
            aria-label="Template to test"
            className={`${control} mt-2 w-full`}
          >
            {templates.length === 0 && <option value="">No templates yet</option>}
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
                {t.enabled ? "" : " (disabled)"}
              </option>
            ))}
          </select>

          <div className="mt-2 flex gap-2">
            <input
              name="testTo"
              type="email"
              required
              placeholder="you@example.com"
              aria-label="Send the test to"
              className={`${control} min-w-0 flex-1`}
            />
            <button
              disabled={busy || templates.length === 0}
              className="cb-btn cb-btn-secondary shrink-0 px-2.5 py-1.5 text-[13px]"
            >
              {busy ? "Sending" : "Send test"}
            </button>
          </div>

          {testSent && (
            <p className="mt-2 text-[12px] text-success">{testSent}</p>
          )}
          {testError && (
            <p className="mt-2 text-[12px] text-danger">{testError}</p>
          )}
        </Form>
      </div>
    </div>
  );
}

/* --- Composer --------------------------------------------------------- */

function Composer({
  templates,
  recipientOptions,
  preselected,
  draft,
  preview,
  error,
  note,
  sent,
  failed,
  unsupported,
  busy,
  mailConfigured,
}: {
  templates: {
    key: string;
    name: string;
    subject: string;
    bodyHtml: string;
    enabled: boolean;
  }[];
  recipientOptions: {
    id: string;
    name: string;
    email: string;
    company: string | null;
    group: string;
  }[];
  preselected: string[];
  draft?: Draft;
  preview?: {
    to: string;
    name: string;
    subject: string;
    bodyHtml: string;
    others: number;
  };
  error?: string;
  note?: string;
  sent?: string;
  failed?: boolean;
  unsupported: string[];
  busy: boolean;
  mailConfigured: boolean;
}) {
  const [fields, setFields] = useState(false);
  const [chosenCount, setChosenCount] = useState(preselected.length);

  return (
    <div className="border-b border-line bg-subtle px-6 py-4">
      <Form method="post" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight">
            Write to participants
          </h2>
          <button
            type="button"
            onClick={() => setFields((v) => !v)}
            className="text-[12px] text-accent-text underline-offset-2 hover:underline"
          >
            {fields ? "Hide merge fields" : "Merge fields"}
          </button>
        </div>

        {fields && (
          <dl className="grid gap-x-4 gap-y-1 rounded-md border border-line bg-surface p-3 text-[12px] sm:grid-cols-2">
            {MERGE_FIELDS.map((f) => (
              <div key={f.key} className="flex gap-2">
                <dt className="shrink-0 font-mono text-strong">
                  {`{{${f.key}}}`}
                </dt>
                <dd className="text-dim">{f.description}</dd>
              </div>
            ))}
          </dl>
        )}

        {error && (
          <p className="cb-note cb-note-danger px-3 py-2.5 text-[13px]">{error}</p>
        )}
        {note && (
          <p className="cb-note cb-note-accent px-3 py-2.5 text-[13px]">{note}</p>
        )}
        {unsupported.length > 0 && (
          <p className="cb-note cb-note-warn px-3 py-2.5 text-[13px]">
            This message uses{" "}
            <span className="font-mono">{unsupported.join(", ")}</span>, which a
            one-off send cannot fill in: they belong to a submission, and only
            the screen that knows which submission can supply them. Sent from
            here, the plain fields come out empty and the{" "}
            <span className="font-mono">{"{{#section}}"}</span> markers arrive
            as literal text. Acceptances and declines go out from{" "}
            <Link
              to="/admin/decisions"
              className="underline underline-offset-2"
            >
              Decisions
            </Link>
            .
          </p>
        )}
        {sent && (
          <p
            className={`cb-note ${failed ? "cb-note-warn" : "cb-note-success"} px-3 py-2.5 text-[13px]`}
          >
            {sent} Every one of them is on the log below.
          </p>
        )}

        <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
          <label className="block">
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium">Recipients</span>
              {/* An unfocused multi-select shows its selection faintly,
                  and arriving here from a person's page with one already
                  picked should not look like nothing happened. */}
              <span
                className={[
                  "text-[12px] tabular-nums",
                  chosenCount ? "text-accent-text" : "text-dim",
                ].join(" ")}
              >
                {chosenCount} selected
              </span>
            </span>
            <span className="block text-[12px] text-dim">
              Ctrl or Cmd click for several. The preview renders for the first.
            </span>
            <select
              name="recipientIds"
              multiple
              size={10}
              defaultValue={preselected}
              onChange={(e) =>
                setChosenCount(e.currentTarget.selectedOptions.length)
              }
              className="mt-1 w-full rounded-md border border-line-strong bg-surface px-1 py-1 text-[13px] text-strong"
            >
              {RECIPIENT_GROUPS.map((group) => {
                const inGroup = recipientOptions.filter((r) => r.group === group);
                if (!inGroup.length) return null;
                return (
                  <optgroup key={group} label={`${group} (${inGroup.length})`}>
                    {inGroup.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.email})
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>

          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="block min-w-56 flex-1">
                <span className="text-[13px] font-medium">Template</span>
                <select
                  name="templateKey"
                  defaultValue={draft?.templateKey ?? ""}
                  className={field}
                >
                  <option value="">One-off, written below</option>
                  {templates.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                      {t.enabled ? "" : " (disabled)"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                name="intent"
                value="load_template"
                disabled={busy}
                className="cb-btn cb-btn-secondary px-2.5 py-1.5 text-[13px]"
              >
                Load into the boxes
              </button>
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">Subject</span>
              <input
                name="subject"
                defaultValue={draft?.subject ?? ""}
                className={field}
              />
            </label>

            <label className="block">
              <span className="text-[13px] font-medium">Body</span>
              <span className="block text-[12px] text-dim">
                HTML. Merge fields are substituted per recipient.
              </span>
              <textarea
                name="bodyHtml"
                rows={8}
                defaultValue={draft?.bodyHtml ?? ""}
                className={`${field} font-mono text-[12px]`}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                name="intent"
                value="preview"
                disabled={busy}
                className="cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]"
              >
                Preview first recipient
              </button>
              <button
                name="intent"
                value="send"
                disabled={busy}
                onClick={(e) => {
                  if (!confirm("Send this to everybody selected?")) {
                    e.preventDefault();
                  }
                }}
                className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
              >
                {busy ? "Working" : mailConfigured ? "Send" : "Send (logged only)"}
              </button>
            </div>

            {preview && (
              <div className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-[13px]">
                    <span className="text-dim">To</span>{" "}
                    <span className="font-medium text-strong">
                      {preview.name}
                    </span>{" "}
                    <span className="text-dim">&lt;{preview.to}&gt;</span>
                    {preview.others > 0 && (
                      <span className="text-dim">
                        {" "}
                        and {preview.others} other
                        {preview.others === 1 ? "" : "s"}, each with their own
                        merge values
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-[14px] font-semibold text-strong">
                  {preview.subject}
                </div>
                <div className="mt-2">
                  <BodyFrame html={preview.bodyHtml} title="Message preview" />
                </div>
              </div>
            )}
          </div>
        </div>
      </Form>
    </div>
  );
}
