import { useEffect, useState } from "react";
import { useLocation, useRouteLoaderData } from "react-router";
import { THEMES, type Theme } from "~/lib/theme";

/* ------------------------------------------------------------------ *
 * Theme switch.
 *
 * Changing a theme is a CSS variable swap. It should cost one frame, so
 * the click handler does the whole job locally: set data-theme on the
 * document element, write the cookie, done. No fetch, no fetcher, no
 * navigation, and above all no loader revalidation. Revalidating every
 * loader on the page to repaint a palette was the entire cost of the
 * previous version.
 *
 * The surrounding <form> is a plain HTML form, not React Router's, so
 * that with JavaScript disabled it still posts to /theme and the server
 * sets the cookie the old way. With JavaScript, the submit is prevented
 * and that path is never taken.
 * ------------------------------------------------------------------ */

const LABEL: Record<Theme, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

const TITLE: Record<Theme, string> = {
  system: "Follow the operating system setting",
  light: "Always light",
  dark: "Always dark",
};

const COOKIE = "cb_theme";
const ONE_YEAR = 60 * 60 * 24 * 365;

/* Must match what createCookie writes on the server, because the server
   is what reads it back on the next request: JSON, base64, URI encoded. */
function writeThemeCookie(theme: Theme) {
  const base = `Path=/; SameSite=Lax`;
  if (theme === "system") {
    // No stored preference means prefers-color-scheme decides again.
    document.cookie = `${COOKIE}=; ${base}; Max-Age=0`;
    return;
  }
  const value = encodeURIComponent(btoa(JSON.stringify(theme)));
  document.cookie = `${COOKIE}=${value}; ${base}; Max-Age=${ONE_YEAR}`;
}

function applyTheme(theme: Theme) {
  const el = document.documentElement;

  /* Suppress transitions for the swap itself. Colour transitions are
     scoped to interactive elements here, so this is cheap insurance
     rather than a fix, but it keeps a future `transition` on a common
     element from turning a theme switch into a mass animation. */
  el.classList.add("cb-theme-switching");

  if (theme === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);

  // Keep the UA hint in step with the palette.
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute("content", theme === "system" ? "light dark" : theme);
  }

  // Two frames: one for the style change to be committed, one to let the
  // paint happen before transitions are allowed back.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.remove("cb-theme-switching"));
  });
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const root = useRouteLoaderData("root") as { theme?: Theme } | undefined;
  const location = useLocation();

  /* Local state, because nothing revalidates after a switch: the root
     loader's value is only authoritative on a fresh document. */
  const [theme, setTheme] = useState<Theme>(root?.theme ?? "system");

  // If a fresh document arrives with a different stored preference (the
  // no-JS path, or another tab), fall back in line with it.
  useEffect(() => {
    if (root?.theme && root.theme !== theme) setTheme(root.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root?.theme]);

  const choose = (next: Theme) => {
    applyTheme(next);
    writeThemeCookie(next);
    setTheme(next);
  };

  const returnTo = `${location.pathname}${location.search}`;

  return (
    <form
      method="post"
      action="/theme"
      // Only ever runs when hydrated. Without JavaScript this handler
      // does not exist and the browser posts the form normally.
      onSubmit={(e) => e.preventDefault()}
      className={[
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-subtle p-0.5",
        compact ? "" : "w-full",
      ].join(" ")}
    >
      <input type="hidden" name="returnTo" value={returnTo} />
      {THEMES.map((t) => {
        const active = t === theme;
        return (
          <button
            key={t}
            type="submit"
            name="theme"
            value={t}
            aria-pressed={active}
            title={TITLE[t]}
            onClick={(e) => {
              e.preventDefault();
              choose(t);
            }}
            className={[
              "flex-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors",
              active
                ? "bg-invert text-invert-fg"
                : "text-dim hover:bg-muted hover:text-strong",
            ].join(" ")}
          >
            {LABEL[t]}
          </button>
        );
      })}
    </form>
  );
}
