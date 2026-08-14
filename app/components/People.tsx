import { useState } from "react";

/* ------------------------------------------------------------------ *
 * Small pieces the roster, the person page and the email composer all
 * use, so a person looks the same wherever they turn up.
 * ------------------------------------------------------------------ */

/* A link the producer is meant to hand to somebody. Selectable as text
   for the browsers where the clipboard API is blocked, and copyable in
   one click for everywhere else. */
export function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        className="cb-input min-w-0 flex-1 px-2 py-1 font-mono text-[12px]"
      />
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => {
              setDone(true);
              setTimeout(() => setDone(false), 1800);
            },
            () => setDone(false),
          );
        }}
        className="cb-btn cb-btn-secondary shrink-0 px-2 py-1 text-[12px]"
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/* Headshot if there is one, initials if there is not. Never a broken
   image icon, because half a roster has no photo until the week of. */
export function Avatar({
  src,
  name,
  size = 28,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return src ? (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full object-cover ring-1 ring-line"
    />
  ) : (
    <span
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-dim ring-1 ring-line"
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}
