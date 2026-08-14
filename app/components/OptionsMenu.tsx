import { useSearchParams } from "react-router";

/* ------------------------------------------------------------------ *
 * Options menu.
 *
 * A <details> element, so it opens on click, closes on Escape and works
 * with JavaScript disabled. The items are plain links to the export
 * route carrying the current query string, which means the download is
 * an ordinary GET the browser handles itself: no fetch, no blob, no
 * object URL to revoke.
 * ------------------------------------------------------------------ */

export function OptionsMenu({
  source,
  rowCount,
  scopeNote,
}: {
  source: "submissions" | "abstracts" | "sessions" | "agenda" | "evaluations";
  rowCount: number;
  scopeNote: string;
}) {
  const [params] = useSearchParams();

  const href = (format: "csv" | "xlsx") => {
    const next = new URLSearchParams(params);
    next.set("source", source);
    next.set("format", format);
    return `/admin/export?${next}`;
  };

  return (
    <details className="group relative">
      <summary className="cb-btn cb-btn-secondary flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[13px] [&::-webkit-details-marker]:hidden">
        Options
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className="opacity-60">
          <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>

      <div className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
        <div className="border-b border-line-soft px-3 py-2">
          <div className="text-[12px] font-medium text-strong">
            Export {rowCount} {rowCount === 1 ? "row" : "rows"}
          </div>
          <div className="text-[12px] text-dim">{scopeNote}</div>
        </div>
        <a
          href={href("csv")}
          className="block px-3 py-2 text-[13px] text-body hover:bg-subtle hover:text-strong"
        >
          Export CSV
        </a>
        <a
          href={href("xlsx")}
          className="block px-3 py-2 text-[13px] text-body hover:bg-subtle hover:text-strong"
        >
          Export XLSX
        </a>
      </div>
    </details>
  );
}
