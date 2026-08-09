import { Form, Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { eq, sql, and, ne } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import { forms, submissions, fieldDefinitions, formFields } from "~/db/schema";

export async function loader({ context }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const rows = await db
    .select({
      id: forms.id,
      name: forms.name,
      kind: forms.kind,
      status: forms.status,
      publicSlug: forms.publicSlug,
      closeAt: forms.closeAt,
      submissionLimit: forms.submissionLimit,
    })
    .from(forms)
    .where(eq(forms.eventId, DEMO_EVENT_ID))
    .orderBy(forms.createdAt);

  const counts = await db
    .select({
      formId: submissions.formId,
      total: sql<number>`count(*)`,
      drafts: sql<number>`sum(case when ${submissions.status} = 'draft' then 1 else 0 end)`,
    })
    .from(submissions)
    .where(eq(submissions.eventId, DEMO_EVENT_ID))
    .groupBy(submissions.formId);

  const countMap = new Map(
    counts.map((c) => [c.formId, { total: Number(c.total), drafts: Number(c.drafts) }]),
  );

  return {
    rows: rows.map((r) => ({
      ...r,
      counts: countMap.get(r.id) ?? { total: 0, drafts: 0 },
    })),
    ms: Date.now() - started,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "create") {
    const kind = String(fd.get("kind") ?? "sessions");
    const id = crypto.randomUUID();
    const slug = `form-${Math.random().toString(36).slice(2, 8)}`;

    await db.insert(forms).values({
      id,
      eventId: DEMO_EVENT_ID,
      name: kind === "abstracts" ? "New abstract form" : "New session form",
      publicSlug: slug,
      kind,
      status: "draft",
      collectParticipants: true,
      welcomeHtml: "<p>Tell us what you would like to present.</p>",
      successHtml: "<p>Thanks, we have your submission.</p>",
    });

    // Seed with the locked fields every form needs, so a new form is
    // immediately usable rather than an empty shell.
    const defs = await db
      .select()
      .from(fieldDefinitions)
      .where(eq(fieldDefinitions.eventId, DEMO_EVENT_ID));

    const pick = (key: string) => defs.find((d) => d.key === key);
    const starter: [string, "submission" | "participant", boolean][] = [
      ["title", "submission", true],
      ["description", "submission", true],
      ["format", "submission", true],
      ["track", "submission", true],
      ["first_name", "participant", true],
      ["last_name", "participant", true],
      ["email", "participant", true],
      ["bio", "participant", false],
    ];

    let order = 0;
    for (const [key, step, required] of starter) {
      const def = pick(key);
      if (!def) continue;
      await db.insert(formFields).values({
        formId: id,
        fieldDefinitionId: def.id,
        step,
        sortOrder: order++,
        required,
        locked: def.locked,
      });
    }

    return redirect(`/admin/forms/${id}`);
  }

  if (intent === "toggle_status") {
    const formId = String(fd.get("formId"));
    const next = String(fd.get("next"));
    await db.update(forms).set({ status: next }).where(eq(forms.id, formId));
  }

  return { ok: true };
}

const STATUS: Record<string, string> = {
  open: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  closed: "bg-slate-100 text-slate-600 ring-slate-500/20",
  draft: "bg-amber-50 text-amber-700 ring-amber-600/20",
};

export default function Forms() {
  const { rows, ms } = useLoaderData<typeof loader>();

  return (
    <div>
      <div className="border-b border-slate-200 bg-white px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Forms</h1>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Collect abstracts and session proposals. Each form has its own
              public link.
            </p>
          </div>
          <div className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-500">
            {ms} ms
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="kind" value="sessions" />
            <button className="rounded-md bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-700">
              New session form
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="kind" value="abstracts" />
            <button className="rounded-md border border-slate-300 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50">
              New abstract form
            </button>
          </Form>
        </div>
      </div>

      <div className="space-y-2 px-6 py-4">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white px-6 py-16 text-center">
            <p className="text-[14px] font-medium text-slate-900">No forms yet</p>
            <p className="mt-1 text-[13px] text-slate-500">
              Create a form to start collecting submissions.
            </p>
          </div>
        ) : (
          rows.map((f) => {
            const closed = f.closeAt && new Date(f.closeAt).getTime() < Date.now();
            return (
              <div
                key={f.id}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    to={`/admin/forms/${f.id}`}
                    prefetch="intent"
                    className="text-[14px] font-medium text-slate-900 underline-offset-2 hover:text-indigo-700 hover:underline"
                  >
                    {f.name}
                  </Link>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS[f.status] ?? STATUS.draft}`}
                  >
                    {f.status}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    {f.kind === "abstracts" ? "Abstracts" : "Sessions"}
                  </span>
                  {closed && f.status === "open" && (
                    <span
                      className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20"
                      title="Marked open but the close date has passed, so submitters see a closed form"
                    >
                      Deadline passed
                    </span>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    <a
                      href={`/submit/${f.publicSlug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-slate-300 px-2 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Open public form
                    </a>
                    <Form method="post">
                      <input type="hidden" name="intent" value="toggle_status" />
                      <input type="hidden" name="formId" value={f.id} />
                      <input
                        type="hidden"
                        name="next"
                        value={f.status === "open" ? "closed" : "open"}
                      />
                      <button className="rounded-md border border-slate-300 px-2 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50">
                        {f.status === "open" ? "Close" : "Open"}
                      </button>
                    </Form>
                  </div>
                </div>

                <div className="mt-1.5 flex gap-4 text-[12px] text-slate-500 tabular-nums">
                  <span>{f.counts.total} submissions</span>
                  <span>{f.counts.drafts} drafts</span>
                  {f.closeAt && (
                    <span>
                      Closes {new Date(f.closeAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  )}
                  <span className="font-mono text-slate-400">/submit/{f.publicSlug}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
