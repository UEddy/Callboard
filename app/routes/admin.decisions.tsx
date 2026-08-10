import { Form, Link, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, eq, inArray, desc } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  submissions,
  submissionParticipants,
  participants,
  tracks,
  rooms,
  events,
  emailTemplates,
  emailLog,
  tasks,
  taskAssignments,
} from "~/db/schema";
import { buildIcs, sendEmail, render, invitationUid } from "~/lib/email";

const EVENT_UTC_OFFSET = -7;

function fmtWhen(ms: number | null) {
  if (!ms) return "to be confirmed";
  const d = new Date(ms + EVENT_UTC_OFFSET * 3_600_000);
  const h = d.getUTCHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })} at ${hh}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} PT`;
}

export async function loader({ context }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const rows = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      startsAt: submissions.startsAt,
      notifiedAt: submissions.notifiedAt,
      trackName: tracks.name,
      roomName: rooms.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(
      and(
        eq(submissions.eventId, DEMO_EVENT_ID),
        inArray(submissions.status, [
          "accept_queue",
          "decline_queue",
          "accepted",
          "declined",
        ]),
      ),
    );

  const ids = rows.map((r) => r.id);
  const people = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          firstName: participants.firstName,
          lastName: participants.lastName,
          email: participants.email,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
    : [];

  const byId = new Map<string, { name: string; email: string }[]>();
  for (const p of people) {
    const arr = byId.get(p.submissionId) ?? [];
    arr.push({
      name: [p.firstName, p.lastName].filter(Boolean).join(" "),
      email: p.email,
    });
    byId.set(p.submissionId, arr);
  }

  const log = await db
    .select()
    .from(emailLog)
    .where(eq(emailLog.eventId, DEMO_EVENT_ID))
    .orderBy(desc(emailLog.createdAt))
    .limit(15);

  const env = context.get(cloudflareContext).env as unknown as {
    RESEND_API_KEY?: string;
  };

  return {
    acceptQueue: rows.filter((r) => r.status === "accept_queue"),
    declineQueue: rows.filter((r) => r.status === "decline_queue"),
    unnotified: rows.filter(
      (r) =>
        (r.status === "accepted" || r.status === "declined") && !r.notifiedAt,
    ),
    speakers: Object.fromEntries(byId),
    log,
    mailConfigured: Boolean(env.RESEND_API_KEY),
    ms: Date.now() - started,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const env = context.get(cloudflareContext).env;
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  if (!event) return { ok: false };

  /* --- Move between queue states without sending anything ---------- */
  if (intent === "queue") {
    await db
      .update(submissions)
      .set({ status: String(fd.get("next")) })
      .where(eq(submissions.id, String(fd.get("submissionId"))));
    return { ok: true };
  }

  /* --- Commit the queues: decide, then notify ---------------------- */
  if (intent === "commit" || intent === "resend") {
    const targets =
      intent === "resend"
        ? [String(fd.get("submissionId"))]
        : (fd.getAll("ids") as string[]);

    const templates = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.eventId, DEMO_EVENT_ID));

    const acceptTpl = templates.find((t) => t.key === "acceptance");
    const declineTpl = templates.find((t) => t.key === "decline");

    const taskList = await db
      .select()
      .from(tasks)
      .where(eq(tasks.eventId, DEMO_EVENT_ID));

    let sent = 0;
    let simulated = 0;

    for (const id of targets.filter(Boolean)) {
      const sub = await db
        .select({
          id: submissions.id,
          ref: submissions.ref,
          title: submissions.title,
          status: submissions.status,
          format: submissions.format,
          startsAt: submissions.startsAt,
          endsAt: submissions.endsAt,
          roomName: rooms.name,
        })
        .from(submissions)
        .leftJoin(rooms, eq(submissions.roomId, rooms.id))
        .where(eq(submissions.id, id))
        .then((r) => r[0]);
      if (!sub) continue;

      const decided =
        sub.status === "accept_queue"
          ? "accepted"
          : sub.status === "decline_queue"
            ? "declined"
            : sub.status;

      const speakers = await db
        .select({
          id: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
          email: participants.email,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(eq(submissionParticipants.submissionId, id));

      const accepted = decided === "accepted";
      const tpl = accepted ? acceptTpl : declineTpl;

      // Sequence rises on every send for this submission, which is what
      // makes a later room assignment update the existing calendar entry.
      const priorSends = await db
        .select({ seq: emailLog.icsSequence })
        .from(emailLog)
        .where(
          and(eq(emailLog.submissionId, id), eq(emailLog.templateKey, "acceptance")),
        );
      const sequence = priorSends.reduce(
        (m, r) => Math.max(m, (r.seq ?? 0) + 1),
        0,
      );

      const uid = invitationUid(id, event.slug);

      for (const sp of speakers) {
        const vars: Record<string, string> = {
          "participant.firstName": sp.firstName ?? "there",
          "event.name": event.name,
          "submission.title": sub.title,
          "submission.ref": sub.ref,
          "submission.startsAt": fmtWhen(
            sub.startsAt ? new Date(sub.startsAt).getTime() : null,
          ),
          "room.name": sub.roomName ?? "",
          portalUrl: `${new URL(request.url).origin}/portal`,
        };

        const subject = render(tpl?.subject ?? "Update on your submission", vars);
        const html = render(tpl?.bodyHtml ?? "<p>Update on your submission.</p>", vars)
          .replace(/\{\{#room\}\}(.*?)\{\{\/room\}\}/gs, (_, inner) =>
            sub.roomName ? render(inner, vars) : "",
          );

        let ics: string | undefined;
        if (accepted && sub.startsAt) {
          ics = buildIcs({
            uid,
            sequence,
            start: new Date(sub.startsAt),
            end: sub.endsAt
              ? new Date(sub.endsAt)
              : new Date(new Date(sub.startsAt).getTime() + 25 * 60_000),
            title: sub.title,
            description: `${sub.ref} at ${event.name}. Manage your session at ${vars.portalUrl}`,
            location: sub.roomName ?? undefined,
            organizerName: event.name,
            organizerEmail: "hello@ai.engineer",
            attendees: [
              {
                name: [sp.firstName, sp.lastName].filter(Boolean).join(" "),
                email: sp.email,
              },
            ],
          });
        }

        const result = await sendEmail(env, {
          to: sp.email,
          subject,
          html,
          ics,
          icsFilename: `${sub.ref}.ics`,
        });

        if (result.simulated) simulated++;
        else if (result.ok) sent++;

        await db.insert(emailLog).values({
          eventId: DEMO_EVENT_ID,
          participantId: sp.id,
          submissionId: id,
          templateKey: accepted ? "acceptance" : "decline",
          toEmail: sp.email,
          subject,
          status: result.ok ? (result.simulated ? "queued" : "sent") : "failed",
          error: result.error ?? null,
          icsUid: ics ? uid : null,
          icsSequence: ics ? sequence : null,
          sentAt: result.ok && !result.simulated ? new Date() : null,
        });

        // Accepting a speaker creates their onboarding obligations.
        if (accepted) {
          for (const t of taskList) {
            const existing = await db
              .select({ id: taskAssignments.id })
              .from(taskAssignments)
              .where(
                and(
                  eq(taskAssignments.taskId, t.id),
                  eq(taskAssignments.participantId, sp.id),
                ),
              );
            if (existing.length === 0) {
              await db.insert(taskAssignments).values({
                taskId: t.id,
                participantId: sp.id,
                submissionId: id,
                status: "not_started",
              });
            }
          }
        }
      }

      await db
        .update(submissions)
        .set({
          status: decided,
          decidedAt: new Date(),
          notifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(submissions.id, id));
    }

    return { ok: true, sent, simulated };
  }

  return { ok: false };
}

export default function Decisions() {
  const {
    acceptQueue,
    declineQueue,
    unnotified,
    speakers,
    log,
    mailConfigured,
    ms,
  } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const queueBlock = (
    rows: typeof acceptQueue,
    title: string,
    blurb: string,
    accent: string,
  ) => (
    <section className="mb-6">
      <h2 className="text-[15px] font-semibold tracking-tight">
        {title}{" "}
        <span className="font-normal text-faint tabular-nums">
          {rows.length}
        </span>
      </h2>
      <p className="mb-2 mt-0.5 text-[13px] text-dim">{blurb}</p>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-dim">
            Nothing staged here.
          </p>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0"
            >
              <span className="font-mono text-[12px] text-faint">{r.ref}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-strong">
                  {r.title}
                </div>
                <div className="text-[12px] text-dim">
                  {(speakers[r.id] ?? []).map((s) => s.name).join(", ")} ·{" "}
                  {r.trackName ?? "No track"}
                </div>
              </div>
              {r.status === "accept_queue" && !r.startsAt && (
                <span
                  className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn"
                  title="No slot yet, so the invite goes out without a room and gets updated later"
                >
                  Not scheduled
                </span>
              )}
              <Form method="post">
                <input type="hidden" name="intent" value="queue" />
                <input type="hidden" name="submissionId" value={r.id} />
                <input type="hidden" name="next" value="pending" />
                <button className="text-[12px] text-faint underline-offset-2 hover:text-strong hover:underline">
                  Put back
                </button>
              </Form>
            </div>
          ))
        )}
      </div>

      {rows.length > 0 && (
        <Form method="post" className="mt-2">
          <input type="hidden" name="intent" value="commit" />
          {rows.map((r) => (
            <input key={r.id} type="hidden" name="ids" value={r.id} />
          ))}
          <button
            disabled={busy}
            className={`cb-btn px-3 py-1.5 text-[13px] ${accent}`}
          >
            {busy ? "Sending" : `Commit and notify ${rows.length}`}
          </button>
        </Form>
      )}
    </section>
  );

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              Decisions
            </h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Stage decisions, review them, then send. Nothing leaves until you
              commit.
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>
      </div>

      <div className="px-6 py-4">
        {!mailConfigured && (
          <div className="mb-4 rounded-lg border border-warn-ring bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <strong className="font-medium">Email is not connected.</strong>{" "}
            Decisions will be recorded and logged, but nothing will actually be
            delivered. Add a RESEND_API_KEY secret to send for real.
          </div>
        )}

        {queueBlock(
          acceptQueue,
          "Ready to accept",
          "Each speaker gets an acceptance email and a calendar invite. Sessions without a slot get an invite with no room, updated automatically when you schedule them.",
          "cb-btn-success",
        )}

        {queueBlock(
          declineQueue,
          "Ready to decline",
          "A short, kind decline. No calendar invite.",
          "cb-btn-primary",
        )}

        {unnotified.length > 0 && (
          <section className="mb-6">
            <h2 className="text-[15px] font-semibold tracking-tight text-danger">
              Decided but never told
            </h2>
            <p className="mb-2 mt-0.5 text-[13px] text-dim">
              These have a decision on record and no email went out. Usually
              means something failed quietly.
            </p>
            <div className="overflow-hidden rounded-lg border border-danger-ring bg-surface">
              {unnotified.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0"
                >
                  <span className="font-mono text-[12px] text-faint">
                    {r.ref}
                  </span>
                  <span className="flex-1 text-[13px] font-medium">
                    {r.title}
                  </span>
                  <span className="text-[12px] text-dim">{r.status}</span>
                  <Form method="post">
                    <input type="hidden" name="intent" value="resend" />
                    <input type="hidden" name="submissionId" value={r.id} />
                    <button
                      disabled={busy}
                      className="rounded-md border border-line-strong px-2 py-1 text-[12px] font-medium hover:bg-subtle disabled:opacity-50"
                    >
                      Send now
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="text-[15px] font-semibold tracking-tight">
            Recent mail
          </h2>
          <p className="mb-2 mt-0.5 text-[13px] text-dim">
            Every send is logged, including the calendar sequence number.
          </p>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            {log.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-dim">
                Nothing sent yet.
              </p>
            ) : (
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-subtle text-[11px] uppercase tracking-[0.06em] text-dim">
                    <th className="px-4 py-2 font-medium">To</th>
                    <th className="px-4 py-2 font-medium">Subject</th>
                    <th className="px-4 py-2 font-medium">Template</th>
                    <th className="px-4 py-2 font-medium">Invite</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((l) => (
                    <tr key={l.id} className="border-b border-line-soft last:border-0">
                      <td className="px-4 py-2 text-body">{l.toEmail}</td>
                      <td className="max-w-xs truncate px-4 py-2">{l.subject}</td>
                      <td className="px-4 py-2 text-dim">{l.templateKey}</td>
                      <td className="px-4 py-2 text-dim tabular-nums">
                        {l.icsUid ? `seq ${l.icsSequence}` : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={[
                            "rounded px-1.5 py-0.5 text-[11px] font-medium",
                            l.status === "sent"
                              ? "bg-success-soft text-success"
                              : l.status === "failed"
                                ? "bg-danger-soft text-danger"
                                : "bg-muted text-body",
                          ].join(" ")}
                        >
                          {l.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
