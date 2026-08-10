import { redirect } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { isTheme, serializeTheme } from "~/lib/theme";

/* Resource route for the theme switch. A plain form post so the control
   works with JavaScript disabled and, more usefully, so the next
   document already carries the right palette rather than being repainted
   on the client. */
export async function action({ request }: ActionFunctionArgs) {
  const fd = await request.formData();
  const value = String(fd.get("theme") ?? "system");
  const theme = isTheme(value) ? value : "system";

  // Only same-origin paths, so the switch cannot be used as an open
  // redirect from a crafted link.
  const raw = String(fd.get("returnTo") ?? "/");
  const returnTo = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  return redirect(returnTo, {
    headers: { "Set-Cookie": await serializeTheme(theme) },
  });
}

export function loader() {
  return redirect("/");
}
