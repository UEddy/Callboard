import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { and, eq, inArray, like, desc, sql } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  submissions,
  submissionParticipants,
  participants,
  tracks,
} from "~/db/schema";

/* ------------------------------------------------------------------ *
 * Tabs mirror the real decision workflow: accept_queue and
 * decline_queue are staging states, so a producer can batch decisions
 * and review them before anything is committed or emailed.
 * ------------------------------------------------------------------ */

const TABS = [
  { key: "all", label: "All", statuses: null },
  { key: "pending", label: "Pending", statuses: ["pending", "submitted"] },
  { key: "accept_queue", label: "Accept queue", statuses: ["accept_queue"] },
  { key: "accepted", label: "Accepted", statuses: ["accepted"] },
  { key: "decline_queue", label: "Decline queue", statuses: ["decline_queue"] },
  { key: "declined", label: "Declined", statuses: ["declined"] },
  { key: "drafts", label: "Drafts", statuses: ["draft"] },
  { key: "withdrawn", label: "Withdrawn", statuses: ["withdrawn"] },
] as const;

const STATUS_STYLE: Record<string, string> = {
  accepted: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  accept_queue: "bg-emerald-50/60 text-emerald-600 ring-emerald-600/15",
  pending: "bg-amber-50 text-amber-700 ring-amber-600/20",
  submitted: "bg-amber-50 text-amber-700 ring-amber-600/20",
  decline_queue: "bg-rose-50/60 text-rose-600 ring-rose-600/15",
  declined: "bg-rose-50 text-rose-700 ring-rose-600/20",
  draft: "bg-slate-100 text-slate-600 ring-slate-500/20",
  withdrawn: "bg-slate-100 text-slate-500 ring-slate-500/20",
};

const STATUS_LABEL: Record<string, string> = {
  accept_queue: "In accept queue",
  decline_queue: "In decline queue",
  submitted: "Pending",
};

function label(status: string) {
  return (
    STATUS_LABEL[status] ??
    status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")
  );
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);

  const tabKey = url.searchParams.get("tab") ?? "all";
  const q = (url.searchParams.get("q") ?? "").trim();
  const trackFilter = url.searchParams.get("track") ?? "";

  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[0];

  const where = and(
    eq(submissions.eventId, DEMO_EVENT_ID),
    tab.statuses ? inArray(submissions.status, [...tab.statuses]) : undefined,
    q ? like(submissions.title, `%${q}%`) : undefined,
    trackFilter ? eq(submissions.trackId, trackFilter) : undefined,
  );

  // One query for counts across every tab, so the badges stay honest
  // without eight round trips.
  const countRows = await db
    .select({ status: submissions.status, n: sql<number>`count(*)` })
    .from(submissions)
    .where(eq(submissions.eventId, DEMO_EVENT_ID))
    .groupBy(submissions.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of countRows) {
    byStatus[r.status] = Number(r.n);
    total += Number(r.n);
  }

  const rows = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      level: submissions.level,
      trackName: tracks.name,
      trackColor: tracks.color,
      submittedAt: submissions.submittedAt,
      notifiedAt: submissions.notifiedAt,
      decidedAt: submissions.decidedAt,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .where(where)
    .orderBy(desc(submissions.refSeq));

  // Speakers in one follow-up query rather than N joins per row.
  const ids = rows.map((r) => r.id);
  const speakerRows = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          firstName: participants.firstName,
          lastName: participants.lastName,
          company: participants.company,
          isPrimary: submissionParticipants.isPrimary,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
    : [];

  const speakersBySubmission: Record<
    string,
    { name: string; company: string | null }[]
  > = {};
  for (const s of speakerRows) {
    (speakersBySubmission[s.submissionId] ??= []).push({
      name: [s.firstName, s.lastName].filter(Boolean).join(" "),
      company: s.company,
    });
  }

  const trackList = await db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, DEMO_EVENT_ID))
    .orderBy(tracks.sortOrder);

  const tabCounts = TABS.map((t) => ({
    key: t.key,
    n: t.statuses
      ? t.statuses.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0)
      : total,
  }));

  return {
    rows,
    speakersBySubmission,
    trackList,
    tabCounts,
    tabKey: tab.key,
    q,
    trackFilter,
    ms: Date.now() - started,
  };
}

function timeAgo(d: Date | null) {
  if (!d) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function Submissions() {
  const {
    rows,
    speakersBySubmission,
    trackList,
    tabCounts,
    tabKey,
    q,
    trackFilter,
    ms,
  } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  const countFor = (k: string) => tabCounts.find((t) => t.key === k)?.n ?? 0;

  return (
    <div>
      {/* Header */}
      <div className="border-b border-slate-200 bg-white">
        <div className="flex items-baseline justify-between px-6 pt-5">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              Submissions
            </h1>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Review, decide, and notify. Decisions stage in a queue before
              anything is sent.
            </p>
          </div>
          <div
            className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-500"
            title="Server render time for this page"
          >
            {ms} ms
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-4 flex gap-1 overflow-x-auto px-6">
          {TABS.map((t) => {
            const active = t.key === tabKey;
            const next = new URLSearchParams(params);
            next.set("tab", t.key);
            return (
              <Link
                key={t.key}
                to={`?${next}`}
                prefetch="intent"
                className={[
                  "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors",
                  active
                    ? "border-indigo-600 font-medium text-indigo-700"
                    : "border-transparent text-slate-500 hover:text-slate-900",
                ].join(" ")}
              >
                {t.label}
                <span
                  className={[
                    "rounded px-1.5 py-0.5 text-[11px] tabular-nums",
                    active
                      ? "bg-indigo-100 text-indigo-700"
                      : "bg-slate-100 text-slate-500",
                  ].join(" ")}
                >
                  {countFor(t.key)}
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <Form method="get" className="flex flex-wrap gap-2 px-6 py-3">
        <input type="hidden" name="tab" value={tabKey} />
        <input
          name="q"
          defaultValue={q}
          placeholder="Search titles"
          className="w-64 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <select
          name="track"
          defaultValue={trackFilter}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        >
          <option value="">All tracks</option>
          {trackList.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-700"
        >
          Apply
        </button>
        {(q || trackFilter) && (
          <Link
            to={`?tab=${tabKey}`}
            className="self-center text-[13px] text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
          >
            Clear
          </Link>
        )}
      </Form>

      {/* Table */}
      <div className="px-6 pb-10">
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          {rows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[14px] font-medium text-slate-900">
                No submissions match this view
              </p>
              <p className="mt-1 text-[13px] text-slate-500">
                {q || trackFilter
                  ? "Try clearing the filters."
                  : "Submissions appear here as they come in through your form."}
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] uppercase tracking-[0.06em] text-slate-500">
                  <th className="px-4 py-2 font-medium">Ref</th>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Speakers</th>
                  <th className="px-4 py-2 font-medium">Track</th>
                  <th className="px-4 py-2 font-medium">Format</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Notified</th>
                  <th className="px-4 py-2 font-medium">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const speakers = speakersBySubmission[r.id] ?? [];
                  const decidedNotNotified =
                    (r.status === "accepted" || r.status === "declined") &&
                    !r.notifiedAt;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[12px] text-slate-500">
                        {r.ref}
                      </td>
                      <td className="max-w-sm px-4 py-2.5">
                        <Link
                          to={`/admin/submissions/${r.id}`}
                          prefetch="intent"
                          className="font-medium text-slate-900 underline-offset-2 hover:text-indigo-700 hover:underline"
                        >
                          {r.title || "Untitled"}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {speakers.length === 0 ? (
                          <span className="text-slate-400">None yet</span>
                        ) : (
                          <>
                            {speakers[0].name}
                            {speakers.length > 1 && (
                              <span className="text-slate-400">
                                {" "}
                                +{speakers.length - 1}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {r.trackName ? (
                          <span className="inline-flex items-center gap-1.5 text-slate-600">
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ background: r.trackColor ?? "#94a3b8" }}
                            />
                            {r.trackName}
                          </span>
                        ) : (
                          <span className="text-slate-400">Unassigned</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {r.format ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span
                          className={[
                            "rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                            STATUS_STYLE[r.status] ?? STATUS_STYLE.draft,
                          ].join(" ")}
                        >
                          {label(r.status)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {r.notifiedAt ? (
                          <span className="text-slate-500 tabular-nums">
                            {timeAgo(new Date(r.notifiedAt))}
                          </span>
                        ) : decidedNotNotified ? (
                          <span
                            className="font-medium text-rose-600"
                            title="Decided but the speaker was never emailed"
                          >
                            Not sent
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500 tabular-nums">
                        {r.submittedAt ? (
                          timeAgo(new Date(r.submittedAt))
                        ) : (
                          <span className="text-slate-400">Not submitted</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="mt-2 text-[12px] text-slate-400 tabular-nums">
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </p>
      </div>
    </div>
  );
}

