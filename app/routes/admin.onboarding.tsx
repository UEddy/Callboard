import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  submissions,
  submissionParticipants,
  participants,
  tasks,
  taskAssignments,
  emailLog,
  emailTemplates,
  events,
} from "~/db/schema";
import { render, sendEmail } from "~/lib/email";
import { mergeVars, usesMagicLink } from "~/lib/emails";
import { mintSignInLink } from "~/lib/people";
import { fmtDateIn, safeZone } from "~/lib/tz";

/* ------------------------------------------------------------------ *
 * The screen a producer lives in during the two weeks before an event:
 * who is holding up the show, and one click to chase them.
 * Sorted worst first, because that is the only order that matters.
 * ------------------------------------------------------------------ */

const NUDGE_COOLDOWN_HOURS = 24;

export async function loader({ context }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const taskList = await db
    .select()
    .from(tasks)
    .where(eq(tasks.eventId, DEMO_EVENT_ID))
    .orderBy(tasks.sortOrder);

  // Only accepted speakers have onboarding obligations.
  const speakerRows = await db
    .select({
      participantId: participants.id,
      firstName: participants.firstName,
      lastName: participants.lastName,
      email: participants.email,
      company: participants.company,
      submissionId: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
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
    .where(
      and(
        eq(submissions.eventId, DEMO_EVENT_ID),
        eq(submissions.status, "accepted"),
      ),
    );

  const participantIds = [...new Set(speakerRows.map((r) => r.participantId))];

  const assignments = participantIds.length
    ? await db
        .select()
        .from(taskAssignments)
        .where(inArray(taskAssignments.participantId, participantIds))
    : [];

  const now = Date.now();
  const taskById = new Map(taskList.map((t) => [t.id, t]));

  type Row = {
    participantId: string;
    name: string;
    email: string;
    company: string | null;
    sessions: { ref: string; title: string }[];
    cells: {
      taskId: string;
      status: string;
      required: boolean;
      overdue: boolean;
    }[];
    done: number;
    total: number;
    overdue: number;
    lastNudgedAt: number | null;
  };

  const rows = new Map<string, Row>();

  for (const s of speakerRows) {
    let row = rows.get(s.participantId);
    if (!row) {
      row = {
        participantId: s.participantId,
        name: [s.firstName, s.lastName].filter(Boolean).join(" "),
        email: s.email,
        company: s.company,
        sessions: [],
        cells: [],
        done: 0,
        total: 0,
        overdue: 0,
        lastNudgedAt: null,
      };
      rows.set(s.participantId, row);
    }
    if (!row.sessions.some((x) => x.ref === s.ref)) {
      row.sessions.push({ ref: s.ref, title: s.title });
    }
  }

  for (const row of rows.values()) {
    const mine = assignments.filter((a) => a.participantId === row.participantId);
    for (const t of taskList) {
      const a = mine.find((x) => x.taskId === t.id);
      const status = a?.status ?? "not_started";
      const due = t.dueAt ? new Date(t.dueAt).getTime() : null;
      const isDone = status === "complete" || status === "waived";
      const overdue =
        !isDone && due !== null && due < now && status !== "waived";

      row.cells.push({
        taskId: t.id,
        status: overdue ? "overdue" : status,
        required: t.required,
        overdue,
      });

      if (t.required) {
        row.total += 1;
        if (isDone) row.done += 1;
        if (overdue) row.overdue += 1;
      }

      const nudged = a?.lastNudgedAt ? new Date(a.lastNudgedAt).getTime() : null;
      if (nudged && (!row.lastNudgedAt || nudged > row.lastNudgedAt)) {
        row.lastNudgedAt = nudged;
      }
    }
  }

  // Worst first: most overdue, then least complete, then alphabetical.
  const sorted = [...rows.values()].sort(
    (a, b) =>
      b.overdue - a.overdue ||
      a.done / (a.total || 1) - b.done / (b.total || 1) ||
      a.name.localeCompare(b.name),
  );

  const totals = {
    speakers: sorted.length,
    fullyDone: sorted.filter((r) => r.done === r.total).length,
    withOverdue: sorted.filter((r) => r.overdue > 0).length,
    openItems: sorted.reduce((n, r) => n + (r.total - r.done), 0),
  };

  return { taskList, rows: sorted, totals, ms: Date.now() - started };
}

/* Used until somebody edits the task_reminder template, so a fresh
   install can chase speakers rather than silently doing nothing. */
const DEFAULT_TASK_REMINDER = {
  subject: "Still need a few things from you for {{event.name}}",
  bodyHtml:
    "<p>Hi {{participant.firstName}},</p>" +
    "<p>You have {{openTaskCount}} outstanding item(s) before {{event.name}}:</p>" +
    "{{taskList}}" +
    '<p><a href="{{portalUrl}}">Complete them here</a></p>',
};

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const env = context.get(cloudflareContext).env;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");
  const origin = new URL(request.url).origin;
  const now = new Date();

  const targets =
    intent === "nudge_all"
      ? (fd.getAll("allParticipantIds") as string[])
      : [String(fd.get("participantId"))];

  const ids = targets.filter(Boolean);
  if (!ids.length) return { ok: false };

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  const zone = safeZone(event?.timezone);

  const tpl = await db.query.emailTemplates.findFirst({
    where: and(
      eq(emailTemplates.eventId, DEMO_EVENT_ID),
      eq(emailTemplates.key, "task_reminder"),
    ),
  });

  // A template row that exists but is switched off is a deliberate
  // choice, and the button should say so rather than send anyway.
  if (tpl && !tpl.enabled) {
    return {
      ok: false,
      message:
        "The task reminder template is switched off, so nothing was sent. Turn it back on before chasing anyone.",
    };
  }

  const people = await db
    .select({
      id: participants.id,
      email: participants.email,
      firstName: participants.firstName,
      lastName: participants.lastName,
      company: participants.company,
      jobTitle: participants.jobTitle,
    })
    .from(participants)
    .where(inArray(participants.id, ids));

  /* What each person actually still owes. A reminder that lists nothing,
     or lists something they finished last week, is worse than no
     reminder: it teaches them to ignore the next one. */
  const openRows = await db
    .select({
      participantId: taskAssignments.participantId,
      status: taskAssignments.status,
      taskName: tasks.name,
      dueAt: tasks.dueAt,
      required: tasks.required,
    })
    .from(taskAssignments)
    .innerJoin(tasks, eq(taskAssignments.taskId, tasks.id))
    .where(
      and(
        inArray(taskAssignments.participantId, ids),
        eq(tasks.eventId, DEMO_EVENT_ID),
        inArray(taskAssignments.status, ["not_started", "in_progress"]),
      ),
    )
    .orderBy(asc(tasks.sortOrder));

  const openBy = new Map<string, { name: string; dueAt: Date | null }[]>();
  for (const r of openRows) {
    const arr = openBy.get(r.participantId) ?? [];
    arr.push({ name: r.taskName, dueAt: r.dueAt ? new Date(r.dueAt) : null });
    openBy.set(r.participantId, arr);
  }

  let sent = 0;
  let queued = 0;
  let failed = 0;
  let skipped = 0;
  let firstError: string | null = null;

  const needsLink = usesMagicLink(
    tpl?.subject ?? DEFAULT_TASK_REMINDER.subject,
    tpl?.bodyHtml ?? DEFAULT_TASK_REMINDER.bodyHtml,
  );

  for (const person of people) {
    const open = openBy.get(person.id) ?? [];
    if (open.length === 0) {
      skipped++;
      continue;
    }

    const magicLinkUrl = needsLink
      ? await mintSignInLink(db, person.id, origin)
      : "";

    const listHtml =
      "<ul>" +
      open
        .map(
          (t) =>
            `<li>${escapeHtml(t.name)}${
              t.dueAt
                ? `, due ${escapeHtml(
                    fmtDateIn(t.dueAt.getTime(), zone, {
                      month: "long",
                      day: "numeric",
                    }),
                  )}`
                : ""
            }</li>`,
        )
        .join("") +
      "</ul>";

    const vars = {
      ...mergeVars(person, event, origin, magicLinkUrl),
      openTaskCount: String(open.length),
      taskList: listHtml,
    };

    const subject = render(tpl?.subject ?? DEFAULT_TASK_REMINDER.subject, vars);
    const html = render(tpl?.bodyHtml ?? DEFAULT_TASK_REMINDER.bodyHtml, vars);

    const result = await sendEmail(env, { to: person.email, subject, html });

    if (!result.ok) {
      failed++;
      firstError ??= result.error ?? "send failed";
    } else if (result.simulated) queued++;
    else sent++;

    await db.insert(emailLog).values({
      eventId: DEMO_EVENT_ID,
      participantId: person.id,
      templateKey: "task_reminder",
      toEmail: person.email,
      subject,
      bodyHtml: html,
      status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
      error: result.error ?? null,
      recoveryLink: !result.ok && magicLinkUrl ? magicLinkUrl : null,
      sentAt: result.ok && !result.simulated ? new Date() : null,
    });

    /* "Reminded yesterday" has to mean a reminder left the building. A
       send that failed at the provider leaves the cooldown clear so the
       producer can try again once the problem is fixed. */
    if (result.ok) {
      await db
        .update(taskAssignments)
        .set({ lastNudgedAt: now })
        .where(
          and(
            eq(taskAssignments.participantId, person.id),
            inArray(taskAssignments.status, ["not_started", "in_progress"]),
          ),
        );
    }
  }

  const bits: string[] = [];
  if (sent) bits.push(`${sent} reminder${sent === 1 ? "" : "s"} sent`);
  if (queued)
    bits.push(
      `${queued} logged but not delivered, because no mail provider is configured`,
    );
  if (failed) bits.push(`${failed} failed`);
  if (skipped)
    bits.push(
      `${skipped} skipped with nothing outstanding`,
    );

  return {
    ok: failed === 0,
    sent,
    queued,
    failed,
    message:
      (bits.length ? `${bits.join(", ")}.` : "Nobody had anything outstanding.") +
      (firstError ? ` First error: ${firstError.slice(0, 200)}` : ""),
  };
}

/* The task names come from the producer and land in an HTML email. */
function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CELL: Record<string, { dot: string; label: string }> = {
  complete: { dot: "bg-success-solid", label: "Done" },
  in_progress: { dot: "bg-warn-solid", label: "Started" },
  not_started: { dot: "bg-muted-strong", label: "Not started" },
  overdue: { dot: "bg-danger-solid", label: "Overdue" },
  waived: { dot: "bg-muted-strong ring-1 ring-line-strong", label: "Waived" },
};

function agoLabel(ms: number | null) {
  if (!ms) return null;
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export default function Onboarding() {
  const { taskList, rows, totals, ms } = useLoaderData<typeof loader>();
  const action = useActionData<{
    ok?: boolean;
    failed?: number;
    message?: string;
  }>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const laggards = rows.filter((r) => r.done < r.total);

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 pb-5 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              Speaker onboarding
            </h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Who is still holding things up, worst first.
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Accepted speakers", value: totals.speakers },
            { label: "Fully onboarded", value: totals.fullyDone },
            {
              label: "With overdue items",
              value: totals.withOverdue,
              alert: totals.withOverdue > 0,
            },
            { label: "Open items", value: totals.openItems },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-line bg-surface px-3 py-2.5"
            >
              <div
                className={[
                  "text-[22px] font-semibold tabular-nums",
                  s.alert ? "text-danger" : "text-strong",
                ].join(" ")}
              >
                {s.value}
              </div>
              <div className="text-[12px] text-dim">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-6 py-4">
        {action?.message && (
          <p
            className={[
              "cb-note mb-3 px-3 py-2.5 text-[13px]",
              action.failed ? "cb-note-warn" : "cb-note-success",
            ].join(" ")}
          >
            {action.message}{" "}
            <Link
              to="/admin/emails?template=task_reminder"
              className="underline underline-offset-2"
            >
              Every one is in the email log.
            </Link>
          </p>
        )}

        {laggards.length > 0 && (
          <Form method="post" className="mb-3">
            <input type="hidden" name="intent" value="nudge_all" />
            {laggards.map((r) => (
              <input
                key={r.participantId}
                type="hidden"
                name="allParticipantIds"
                value={r.participantId}
              />
            ))}
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-invert px-3 py-1.5 text-[13px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
            >
              {busy
                ? "Sending"
                : `Remind all ${laggards.length} with open items`}
            </button>
          </Form>
        )}

        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          {rows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[14px] font-medium text-strong">
                No accepted speakers yet
              </p>
              <p className="mt-1 text-[13px] text-dim">
                Onboarding starts once you accept submissions.{" "}
                <Link
                  to="/admin/submissions?tab=accept_queue"
                  className="text-accent-text underline underline-offset-2"
                >
                  Review the accept queue
                </Link>
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line bg-subtle text-[11px] uppercase tracking-[0.06em] text-dim">
                  <th className="px-4 py-2 font-medium">Speaker</th>
                  <th className="px-4 py-2 font-medium">Session</th>
                  {taskList.map((t) => (
                    <th
                      key={t.id}
                      className="px-2 py-2 text-center font-medium"
                      title={t.description ?? undefined}
                    >
                      {t.name.replace(/^(Upload|Confirm|Sign) (your |the )?/i, "")}
                    </th>
                  ))}
                  <th className="px-4 py-2 font-medium">Progress</th>
                  <th className="px-4 py-2 font-medium">Chase</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pct = r.total ? Math.round((r.done / r.total) * 100) : 100;
                  const recentlyNudged =
                    r.lastNudgedAt !== null &&
                    Date.now() - r.lastNudgedAt <
                      NUDGE_COOLDOWN_HOURS * 3_600_000;
                  return (
                    <tr
                      key={r.participantId}
                      className="border-b border-line-soft last:border-0 hover:bg-subtle"
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-strong">{r.name}</div>
                        <div className="text-[12px] text-dim">
                          {r.company ?? r.email}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {r.sessions.map((s) => (
                          <div key={s.ref} className="whitespace-nowrap">
                            <span className="font-mono text-[12px] text-faint">
                              {s.ref}
                            </span>{" "}
                            <span className="text-body">{s.title}</span>
                          </div>
                        ))}
                      </td>
                      {r.cells.map((c) => {
                        const style = CELL[c.status] ?? CELL.not_started;
                        return (
                          <td key={c.taskId} className="px-2 py-2.5 text-center">
                            <span
                              className={[
                                "inline-block h-2.5 w-2.5 rounded-full",
                                style.dot,
                              ].join(" ")}
                              title={style.label}
                            />
                          </td>
                        );
                      })}
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                            <div
                              className={[
                                "h-full rounded-full",
                                r.overdue > 0
                                  ? "bg-danger-solid"
                                  : pct === 100
                                    ? "bg-success-solid"
                                    : "bg-accent-solid",
                              ].join(" ")}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-dim">
                            {r.done}/{r.total}
                          </span>
                          {r.overdue > 0 && (
                            <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger ring-1 ring-inset ring-danger-ring">
                              {r.overdue} overdue
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        {r.done === r.total ? (
                          <span className="text-[12px] text-faint">
                            Nothing outstanding
                          </span>
                        ) : (
                          <Form method="post" className="flex items-center gap-2">
                            <input
                              type="hidden"
                              name="participantId"
                              value={r.participantId}
                            />
                            <button
                              type="submit"
                              disabled={busy}
                              className="rounded-md border border-line-strong px-2 py-1 text-[12px] font-medium text-body hover:border-line-strong hover:bg-subtle disabled:opacity-50"
                            >
                              Remind
                            </button>
                            {r.lastNudgedAt && (
                              <span
                                className={[
                                  "text-[12px]",
                                  recentlyNudged
                                    ? "text-warn"
                                    : "text-faint",
                                ].join(" ")}
                                title={
                                  recentlyNudged
                                    ? "Reminded within the last day, give them a moment"
                                    : undefined
                                }
                              >
                                sent {agoLabel(r.lastNudgedAt)}
                              </span>
                            )}
                          </Form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Legend */}
        <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-dim">
          {Object.entries(CELL).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${v.dot}`} />
              {v.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
