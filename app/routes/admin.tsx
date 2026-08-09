import { NavLink, Outlet, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import { events } from "~/db/schema";

export async function loader({ context }: LoaderFunctionArgs) {
  const db = getDb(context);
  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  return { event };
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
  const { event } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <div className="flex">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
          <div className="border-b border-slate-200 px-4 py-4">
            <div className="text-[13px] font-semibold tracking-tight">
              {event?.name ?? "Callboard"}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
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
                  <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
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
                          ? "bg-indigo-50 font-medium text-indigo-700"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                      ].join(" ")
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="border-t border-slate-200 px-4 py-3">
            <a
              href="/agenda"
              className="text-[12px] text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
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

