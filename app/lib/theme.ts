import { createCookie } from "react-router";

/* ------------------------------------------------------------------ *
 * Theme preference.
 *
 * A cookie rather than localStorage, because the server has to know the
 * answer before it renders a single byte. localStorage is only readable
 * after JavaScript runs, which is precisely one paint too late and is
 * why theme toggles built that way flash the wrong colours.
 *
 * Three states, not two. "system" is the absence of a stored preference,
 * so it is represented by deleting the cookie: with no cookie there is
 * no data-theme attribute on <html>, and the prefers-color-scheme media
 * query in app.css decides. The server does not need to guess.
 * ------------------------------------------------------------------ */

export type Theme = "light" | "dark" | "system";

export const THEMES: Theme[] = ["system", "light", "dark"];

export const themeCookie = createCookie("cb_theme", {
  path: "/",
  sameSite: "lax",
  httpOnly: false,
  maxAge: 60 * 60 * 24 * 365,
});

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export async function readTheme(request: Request): Promise<Theme> {
  const parsed = await themeCookie.parse(request.headers.get("Cookie"));
  return isTheme(parsed) ? parsed : "system";
}

/* Only an explicit choice becomes an attribute. "system" serialises to
   null so the CSS media query stays in charge. */
export function themeAttribute(theme: Theme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}

export async function serializeTheme(theme: Theme) {
  if (theme === "system") {
    return await themeCookie.serialize("", { maxAge: 0 });
  }
  return await themeCookie.serialize(theme);
}
