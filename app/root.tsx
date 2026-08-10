import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { readTheme, themeAttribute, type Theme } from "./lib/theme";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

/* The theme is resolved before the first byte of HTML, so the correct
   palette is in the markup itself. No inline script, no post-hydration
   correction, nothing to flash. */
export async function loader({ request }: LoaderFunctionArgs) {
  return { theme: await readTheme(request) };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const theme: Theme = data?.theme ?? "system";
  const attr = themeAttribute(theme);

  return (
    <html lang="en" data-theme={attr}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Tells the browser which UA palette to use for form controls and
            scrollbars before any CSS has parsed. */}
        <meta
          name="color-scheme"
          content={attr ? attr : "light dark"}
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto p-4 pt-16 text-strong">
      <h1 className="text-[22px] font-semibold tracking-tight">{message}</h1>
      <p className="mt-1 text-[14px] text-dim">{details}</p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded-lg border border-line bg-surface p-4 text-[12px] text-body">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
