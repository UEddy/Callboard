import { useState } from "react";

/* ------------------------------------------------------------------ *
 * Desktop and mobile previews, side by side rather than behind a
 * toggle.
 *
 * An embed usually lands in a page that gets read on both, and the
 * failure a producer needs to catch, an agenda grid that overflows at
 * 390px, is only obvious when the narrow frame is on screen next to the
 * wide one. A toggle hides exactly the comparison that matters.
 * ------------------------------------------------------------------ */

export function PreviewFrames({ url, name }: { url: string; name: string }) {
  // Bumped to force both iframes to refetch after a settings change.
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="border-t border-line-soft">
      <div className="flex items-center justify-between border-b border-line-soft bg-subtle px-4 py-1.5">
        <span className="text-[11px] uppercase tracking-[0.06em] text-dim">
          Live preview
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
        >
          Reload
        </button>
      </div>

      <div className="flex flex-wrap items-start gap-4 p-4">
        <div className="min-w-64 flex-1">
          <div className="mb-1 text-[11px] font-medium text-dim">Desktop</div>
          <iframe
            key={`desktop-${reloadKey}`}
            src={url}
            title={`${name}, desktop preview`}
            className="h-96 w-full rounded-md border border-line bg-canvas"
          />
        </div>

        <div className="shrink-0">
          <div className="mb-1 text-[11px] font-medium text-dim">
            Mobile, 390px
          </div>
          <iframe
            key={`mobile-${reloadKey}`}
            src={url}
            title={`${name}, mobile preview`}
            style={{ width: 390 }}
            className="h-96 rounded-md border border-line bg-canvas"
          />
        </div>
      </div>
    </div>
  );
}
