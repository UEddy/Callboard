import { Form, Link, useFetcher, useSearchParams } from "react-router";
import {
  ALL_STATUSES,
  DECIDED_STATUSES,
  STATUS_STYLE,
  TABS,
  statusLabel,
} from "~/lib/submission-list";
import { dualTimeText, fmtDateIn } from "~/lib/tz";
import { OptionsMenu } from "~/components/OptionsMenu";

/* ------------------------------------------------------------------ *
 * The submissions table, shared by all three scoped lists.
 * ------------------------------------------------------------------ */

type Row = {
  id: string;
  ref: string;
  title: string;
  status: string;
  format: string | null;
  level: string | null;
  trackName: string | null;
  trackColor: string | null;
  submittedAt: string | number | Date | null;
  notifiedAt: string | number | Date | null;
  decidedAt: string | number | Date | null;
};

export type ListData = {
  rows: Row[];
  eventZone: string;
  viewerZone: string | null;
  speakersBySubmission: Record<
    string,
    { name: string; company: string | null; role: string; isPrimary: boolean }[]
  >;
  trackList: { id: string; name: string }[];
  tabCounts: { key: string; n: number }[];
  tabKey: string;
  q: string;
  trackFilter: string;
  ms: number;
};

function exact(ms: number, zone: string, viewer: string | null) {
  return `${fmtDateIn(ms, zone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })} at ${dualTimeText(ms, zone, viewer)}`;
}

function timeAgo(d: Date | null) {
  if (!d) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* --- Inline status editor -------------------------------------------- */

/* A native select rendered as the pill. It opens on click, is reachable
   from the keyboard for free, and degrades to a plain form post when
   JavaScript is unavailable. */
function StatusCell({ row }: { row: Row }) {
  const fetcher = useFetcher();

  // Optimistic: show the value being written while it is in flight.
  const pending = fetcher.formData?.get("status");
  const status = typeof pending === "string" ? pending : row.status;
  const saving = fetcher.state !== "idle";

  const onChange = (next: string) => {
    if (next === row.status) return;

    /* Moving straight to a decided state skips the decisions screen,
       which is where the email and the calendar invite come from. Say so
       before it happens, not after. */
    if (DECIDED_STATUSES.includes(next)) {
      const verb = next === "accepted" ? "accepted" : "declined";
      const ok = confirm(
        `Mark ${row.ref} as ${verb} without telling anyone?\n\n` +
          `No email and no calendar invite go out from this screen. The speaker will not know until you send it from Decisions.\n\n` +
          `If you want them notified, put it in the ${next === "accepted" ? "accept" : "decline"} queue instead and commit it from Decisions.\n\n` +
          `Continue?`,
      );
      if (!ok) return;
    }

    fetcher.submit(
      { intent: "set_status", submissionId: row.id, status: next },
      { method: "post" },
    );
  };

  return (
    <span className="relative inline-flex items-center">
      <span
        className={[
          "pointer-events-none inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
          STATUS_STYLE[status] ?? STATUS_STYLE.draft,
          saving ? "opacity-60" : "",
        ].join(" ")}
      >
        {statusLabel(status)}
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          aria-hidden
          className="opacity-60"
        >
          <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </span>
      <select
        aria-label={`Status for ${row.ref}`}
        value={status}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {ALL_STATUSES.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </select>
    </span>
  );
}

/* --- The list --------------------------------------------------------- */

export function SubmissionsList({
  data,
  title,
  blurb,
  basePath,
  source,
}: {
  data: ListData;
  title: string;
  blurb: string;
  basePath: string;
  source: "submissions" | "abstracts" | "sessions";
}) {
  const {
    rows,
    eventZone,
    viewerZone,
    speakersBySubmission,
    trackList,
    tabCounts,
    tabKey,
    q,
    trackFilter,
    ms,
  } = data;
  const [params] = useSearchParams();
  const countFor = (k: string) => tabCounts.find((t) => t.key === k)?.n ?? 0;

  return (
    <div>
      <div className="border-b border-line bg-surface">
        <div className="flex items-baseline justify-between px-6 pt-5">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
            <p className="mt-0.5 text-[13px] text-dim">{blurb}</p>
          </div>
          <div className="flex items-center gap-2">
            <OptionsMenu
              source={source}
              rowCount={rows.length}
              scopeNote={
                [
                  TABS.find((t) => t.key === tabKey)?.label ?? "All",
                  q ? `matching "${q}"` : null,
                  trackFilter
                    ? `in ${trackList.find((t) => t.id === trackFilter)?.name ?? "a track"}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(", ") + ". Exactly what is on screen."
              }
            />
            <div
              className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim"
              title="Time spent in this page's loader fetching data. It excludes rendering, so it is not total server time: that is in the Server-Timing response header."
            >
              data {ms} ms
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-1 overflow-x-auto px-6">
          {TABS.map((t) => {
            const active = t.key === tabKey;
            const next = new URLSearchParams(params);
            next.set("tab", t.key);
            return (
              <Link
                key={t.key}
                to={`${basePath}?${next}`}
                prefetch="intent"
                className={[
                  "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors",
                  active
                    ? "border-accent-solid font-medium text-accent-text"
                    : "border-transparent text-dim hover:text-strong",
                ].join(" ")}
              >
                {t.label}
                <span
                  className={[
                    "rounded px-1.5 py-0.5 text-[11px] tabular-nums",
                    active
                      ? "bg-accent-soft-strong text-accent-text"
                      : "bg-muted text-dim",
                  ].join(" ")}
                >
                  {countFor(t.key)}
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      <Form method="get" action={basePath} className="flex flex-wrap gap-2 px-6 py-3">
        <input type="hidden" name="tab" value={tabKey} />
        <input
          name="q"
          defaultValue={q}
          placeholder="Search titles"
          className="w-64 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong outline-none placeholder:text-faint focus:border-accent-solid focus:ring-2 focus:ring-accent-ring"
        />
        <select
          name="track"
          defaultValue={trackFilter}
          className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong outline-none focus:border-accent-solid focus:ring-2 focus:ring-accent-ring"
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
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          Apply
        </button>
        {(q || trackFilter) && (
          <Link
            to={`${basePath}?tab=${tabKey}`}
            className="self-center text-[13px] text-dim underline-offset-2 hover:text-strong hover:underline"
          >
            Clear
          </Link>
        )}
      </Form>

      <div className="px-6 pb-10">
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[14px] font-medium text-strong">
                No submissions match this view
              </p>
              <p className="mt-1 text-[13px] text-dim">
                {q || trackFilter
                  ? "Try clearing the filters."
                  : "Submissions appear here as they come in through your form."}
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="cb-thead text-[11px] uppercase tracking-[0.06em]">
                  <th className="px-4 py-2 font-medium">Ref</th>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Participants</th>
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
                      className="cb-row-hover border-b border-line-soft last:border-0"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[12px] text-dim">
                        {r.ref}
                      </td>
                      <td className="max-w-sm px-4 py-2.5">
                        <Link
                          to={`/admin/submissions/${r.id}`}
                          prefetch="intent"
                          className="font-medium text-strong underline-offset-2 hover:text-accent-text hover:underline"
                        >
                          {r.title || "Untitled"}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {speakers.length === 0 ? (
                          <span className="text-faint">None yet</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {speakers.map((sp, i) => (
                              <li
                                key={i}
                                className="flex items-center gap-1.5 whitespace-nowrap"
                              >
                                <span>{sp.name}</span>
                                <span className="cb-pill cb-pill-neutral">
                                  {sp.role}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {r.trackName ? (
                          <span className="inline-flex items-center gap-1.5 text-body">
                            <span
                              className="cb-dot h-2 w-2"
                              style={
                                {
                                  "--cb-hue": r.trackColor ?? "#94a3b8",
                                } as React.CSSProperties
                              }
                            />
                            {r.trackName}
                          </span>
                        ) : (
                          <span className="text-faint">Unassigned</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-body">
                        {r.format ?? <span className="text-faint">None</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <StatusCell row={r} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {r.notifiedAt ? (
                          <span
                            className="text-dim tabular-nums"
                            title={exact(
                              new Date(r.notifiedAt).getTime(),
                              eventZone,
                              viewerZone,
                            )}
                          >
                            {timeAgo(new Date(r.notifiedAt))}
                          </span>
                        ) : decidedNotNotified ? (
                          <Link
                            to="/admin/decisions"
                            className="font-medium text-danger underline-offset-2 hover:underline"
                            title="Decided but the speaker was never emailed. Send it from Decisions."
                          >
                            Not sent
                          </Link>
                        ) : (
                          <span className="text-faint">None</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-dim">
                        {r.submittedAt ? (
                          <span
                            title={exact(
                              new Date(r.submittedAt).getTime(),
                              eventZone,
                              viewerZone,
                            )}
                          >
                            {timeAgo(new Date(r.submittedAt))}
                          </span>
                        ) : (
                          <span className="text-faint">Not submitted</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="mt-2 text-[12px] text-faint tabular-nums">
          {rows.length} {rows.length === 1 ? "row" : "rows"}. Status changes here
          never send email; use{" "}
          <Link
            to="/admin/decisions"
            className="text-accent-text underline underline-offset-2"
          >
            Decisions
          </Link>{" "}
          to notify anyone.
        </p>
      </div>
    </div>
  );
}
