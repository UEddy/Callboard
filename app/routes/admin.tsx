import { Form, NavLink, Outlet, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import { events } from "~/db/schema";
import { ThemeToggle } from "~/components/ThemeToggle";
import { adminContext } from "~/lib/admin-auth";

export async function loader({ context }: LoaderFunctionArgs) {
  const db = getDb(context);
  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  /* The worker has already refused this request if there is no valid
     organiser session, and it passes the row it loaded through the
     context, so this is a read rather than a second query. */
  const me = context.get(adminContext);
  return {
    event,
    me: me
      ? {
          name: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.email,
          email: me.email,
        }
      : null,
  };
}

const NAV = [
  {
    heading: null,
    items: [{ to: "/admin", label: "Dashboard", end: true }],
  },
  {
    heading: "Submissions",
    items: [
      { to: "/admin/submissions", label: "All submissions" },
      { to: "/admin/abstracts", label: "Abstracts" },
      { to: "/admin/sessions", label: "Sessions" },
    ],
  },
  {
    heading: "Collect & review",
    items: [
      { to: "/admin/forms", label: "Forms" },
      { to: "/admin/library", label: "Library" },
      { to: "/admin/evaluation", label: "Evaluation" },
      { to: "/admin/agenda", label: "Agenda" },
    ],
  },
  {
    heading: "Speakers",
    items: [
      { to: "/admin/onboarding", label: "Onboarding" },
      { to: "/admin/people", label: "People" },
      { to: "/admin/tasks", label: "Tasks" },
    ],
  },
  {
    heading: "Publish",
    items: [
      { to: "/admin/embeds", label: "Embeds" },
      { to: "/admin/emails", label: "Emails" },
      { to: "/admin/integrations", label: "Integrations" },
      { to: "/admin/settings", label: "Settings" },
    ],
  },
];

function formatRange(start?: Date | null, end?: Date | null) {
  if (!start) return null;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const a = start.toLocaleDateString("en-US", opts);
  const b = end ? end.toLocaleDateString("en-US", opts) : null;
  const year = start.getFullYear();
  return b ? `${a} to ${b}, ${year}` : `${a}, ${year}`;
}

export default function AdminLayout() {
  const { event, me } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-canvas text-strong">
      <div className="flex">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
          <div className="border-b border-line px-4 py-4">
            <div className="text-[13px] font-semibold tracking-tight">
              {event?.name ?? "Callboard"}
            </div>
            <div className="mt-0.5 text-[11px] text-dim tabular-nums">
              {formatRange(
                event?.startsAt ? new Date(event.startsAt) : null,
                event?.endsAt ? new Date(event.endsAt) : null,
              )}
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-3">
            {NAV.map((group, i) => (
              <div key={i} className="mb-4">
                {group.heading && (
                  <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
                    {group.heading}
                  </div>
                )}
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={"end" in item ? item.end : false}
                    prefetch="intent"
                    className={({ isActive }) =>
                      [
                        "block rounded-md px-2 py-1.5 text-[13px] transition-colors",
                        isActive
                          ? "bg-accent-soft font-medium text-accent-text"
                          : "text-body hover:bg-muted hover:text-strong",
                      ].join(" ")
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="space-y-2 border-t border-line px-4 py-3">
            {me && (
              <div className="flex items-baseline justify-between gap-2 pb-1">
                <span
                  className="truncate text-[12px] text-dim"
                  title={me.email}
                >
                  {me.name}
                </span>
                {/* Posts to the sign-in route, which is the one place
                    that mints and clears the organiser cookie. */}
                <Form method="post" action="/admin/sign-in">
                  <input type="hidden" name="intent" value="sign_out" />
                  <button className="shrink-0 text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline">
                    Sign out
                  </button>
                </Form>
              </div>
            )}
            <ThemeToggle />
            <a
              href={event ? `/e/${event.slug}` : "/"}
              target="_blank"
              rel="noreferrer"
              className="block text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
            >
              View public site
            </a>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

