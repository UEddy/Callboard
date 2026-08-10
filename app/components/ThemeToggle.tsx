import { useFetcher, useLocation, useRouteLoaderData } from "react-router";
import { THEMES, type Theme } from "~/lib/theme";

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

/* Three states rather than two: without an explicit "Auto" there is no
   way back to following the OS once you have touched the switch. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const root = useRouteLoaderData("root") as { theme?: Theme } | undefined;
  const fetcher = useFetcher();
  const location = useLocation();

  // While a switch is in flight, show the value being switched to.
  const pending = fetcher.formData?.get("theme");
  const current: Theme =
    (typeof pending === "string" ? (pending as Theme) : undefined) ??
    root?.theme ??
    "system";

  const returnTo = `${location.pathname}${location.search}`;

  return (
    <fetcher.Form
      method="post"
      action="/theme"
      className={[
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-subtle p-0.5",
        compact ? "" : "w-full",
      ].join(" ")}
    >
      <input type="hidden" name="returnTo" value={returnTo} />
      {THEMES.map((t) => {
        const active = t === current;
        return (
          <button
            key={t}
            type="submit"
            name="theme"
            value={t}
            aria-pressed={active}
            title={TITLE[t]}
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
    </fetcher.Form>
  );
}
