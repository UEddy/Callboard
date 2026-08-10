import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  assignments,
  evaluationPlans,
  participants,
  rooms,
  submissionParticipants,
  submissions,
  tags,
  tracks,
} from "~/db/schema";
import type { RoutingEffect } from "~/lib/routing";

export async function loader({ context, params }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const row = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      description: submissions.description,
      status: submissions.status,
      format: submissions.format,
      level: submissions.level,
      answers: submissions.answers,
      tagIds: submissions.tagIds,
      routingTrail: submissions.routingTrail,
      submittedAt: submissions.submittedAt,
      decidedAt: submissions.decidedAt,
      notifiedAt: submissions.notifiedAt,
      startsAt: submissions.startsAt,
      trackName: tracks.name,
      trackColor: tracks.color,
      roomName: rooms.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(eq(submissions.id, params.id!))
    .then((r) => r[0]);

  if (!row) throw new Response("Submission not found", { status: 404 });

  const speakers = await db
    .select({
      id: participants.id,
      firstName: participants.firstName,
      lastName: participants.lastName,
      email: participants.email,
      company: participants.company,
      role: submissionParticipants.role,
      isPrimary: submissionParticipants.isPrimary,
    })
    .from(submissionParticipants)
    .innerJoin(
      participants,
      eq(submissionParticipants.participantId, participants.id),
    )
    .where(eq(submissionParticipants.submissionId, row.id));

  const tagList = row.tagIds?.length
    ? await db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(tags)
        .where(inArray(tags.id, row.tagIds))
    : [];

  const reviews = await db
    .select({
      id: assignments.id,
      status: assignments.status,
      planName: evaluationPlans.name,
      firstName: participants.firstName,
      lastName: participants.lastName,
    })
    .from(assignments)
    .innerJoin(evaluationPlans, eq(assignments.planId, evaluationPlans.id))
    .innerJoin(participants, eq(assignments.participantId, participants.id))
    .where(eq(assignments.submissionId, row.id));

  return { row, speakers, tagList, reviews, ms: Date.now() - started };
}

const STATUS_STYLE: Record<string, string> = {
  accepted: "bg-success-soft text-success ring-success-ring",
  accept_queue: "bg-success-soft text-success ring-success-ring",
  pending: "bg-warn-soft text-warn ring-warn-ring",
  submitted: "bg-warn-soft text-warn ring-warn-ring",
  decline_queue: "bg-danger-soft text-danger ring-danger-ring",
  declined: "bg-danger-soft text-danger ring-danger-ring",
  draft: "bg-muted text-body ring-line",
  withdrawn: "bg-muted text-dim ring-line",
};

function fmt(d: string | number | Date | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function SubmissionDetail() {
  const { row, speakers, tagList, reviews, ms } = useLoaderData<typeof loader>();
  const trail = (row.routingTrail ?? []) as RoutingEffect[];

  const answers = Object.entries(
    (row.answers ?? {}) as Record<string, unknown>,
  ).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "");

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div className="min-w-0">
            <Link
              to="/admin/submissions"
              className="text-[12px] text-dim underline-offset-2 hover:underline"
            >
              Submissions
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] text-faint">
                {row.ref}
              </span>
              <h1 className="text-[19px] font-semibold tracking-tight">
                {row.title || "Untitled"}
              </h1>
              <span
                className={[
                  "rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                  STATUS_STYLE[row.status] ?? STATUS_STYLE.draft,
                ].join(" ")}
              >
                {row.status.replace(/_/g, " ")}
              </span>
            </div>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>
      </div>

      <div className="grid gap-4 px-6 py-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Proposal</h2>
            <div className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-body">
              {row.description?.replace(/<[^>]+>/g, "") || "No description."}
            </div>
          </section>

          {answers.length > 0 && (
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-[13px] font-semibold">Form answers</h2>
              <dl className="mt-2 space-y-2">
                {answers.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[12px] text-dim">{k}</dt>
                    <dd className="whitespace-pre-wrap text-[13px] text-strong">
                      {String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* Routing trail: the reason this submission is where it is. */}
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">How it got here</h2>
            <p className="mt-0.5 text-[12px] text-dim">
              Rules that fired when this was submitted.
            </p>

            {trail.length === 0 ? (
              <p className="mt-3 text-[13px] text-dim">
                No routing rules matched. Anything set on this submission was
                chosen by the submitter or by hand.
              </p>
            ) : (
              <ol className="mt-3 space-y-2">
                {trail.map((t, i) => (
                  <li
                    key={`${t.ruleId}-${i}`}
                    className="rounded-md border border-line bg-subtle px-3 py-2"
                  >
                    <div className="text-[13px] text-strong">
                      Because <span className="font-medium">{t.condition}</span>
                    </div>
                    <ul className="mt-1 space-y-0.5 text-[12px] text-body">
                      {t.setTrack && (
                        <li>
                          Track set to{" "}
                          <span className="font-medium text-strong">
                            {t.setTrack}
                          </span>
                        </li>
                      )}
                      {t.addedTags?.length ? (
                        <li>
                          Tagged{" "}
                          <span className="font-medium text-strong">
                            {t.addedTags.join(", ")}
                          </span>
                        </li>
                      ) : null}
                      {t.plan && (
                        <li>
                          Sent to{" "}
                          <span className="font-medium text-strong">
                            {t.plan}
                          </span>
                          {typeof t.reviewers === "number" &&
                            ` with ${t.reviewers} reviewer${t.reviewers === 1 ? "" : "s"} assigned`}
                        </li>
                      )}
                      {t.notify?.length ? (
                        <li className="text-dim">
                          Rule lists {t.notify.join(", ")} for notification.
                          Rule driven email is not wired up, so nothing was
                          sent.
                        </li>
                      ) : null}
                    </ul>
                    <div className="mt-1 font-mono text-[10px] text-faint">
                      {t.ruleId} · {fmt(t.appliedAt)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">Details</h2>
            <dl className="mt-2 space-y-1.5 text-[13px]">
              {[
                [
                  "Track",
                  row.trackName ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="cb-dot h-2 w-2"
                        style={{ ["--cb-hue"]: row.trackColor ?? "#94a3b8" } as React.CSSProperties}
                      />
                      {row.trackName}
                    </span>
                  ) : null,
                ],
                ["Format", row.format],
                ["Level", row.level],
                ["Room", row.roomName],
                ["Submitted", fmt(row.submittedAt)],
                ["Decided", fmt(row.decidedAt)],
                ["Notified", fmt(row.notifiedAt)],
              ].map(([label, value]) => (
                <div key={label as string} className="flex gap-3">
                  <dt className="w-20 shrink-0 text-dim">{label}</dt>
                  <dd className="text-strong">
                    {value || <span className="text-faint">Not set</span>}
                  </dd>
                </div>
              ))}
            </dl>

            {tagList.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {tagList.map((t) => (
                  <span
                    key={t.id}
                    className="cb-chip"
                    style={{ ["--cb-hue"]: t.color } as React.CSSProperties}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">
              Speakers{" "}
              <span className="font-normal text-faint">
                {speakers.length}
              </span>
            </h2>
            <ul className="mt-2 space-y-2">
              {speakers.map((s) => (
                <li key={s.id} className="text-[13px]">
                  <div className="font-medium text-strong">
                    {[s.firstName, s.lastName].filter(Boolean).join(" ")}
                    {s.isPrimary && (
                      <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-dim">
                        primary
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-dim">
                    {s.company ?? s.email}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold">
              Review{" "}
              <span className="font-normal text-faint">
                {reviews.length}
              </span>
            </h2>
            {reviews.length === 0 ? (
              <p className="mt-2 text-[13px] text-dim">
                Not assigned for review.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-[13px]">
                {reviews.map((r) => (
                  <li key={r.id} className="flex items-baseline justify-between gap-2">
                    <span className="text-strong">
                      {[r.firstName, r.lastName].filter(Boolean).join(" ")}
                    </span>
                    <span className="text-[12px] text-dim">
                      {r.status}
                    </span>
                  </li>
                ))}
                <li className="pt-1 text-[12px] text-dim">
                  {[...new Set(reviews.map((r) => r.planName))].join(", ")}
                </li>
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
