import { useState } from "react";
import { Form, Link, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { eq, and, asc } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import { forms, formFields, fieldDefinitions } from "~/db/schema";

export async function loader({ context, params }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const formId = params.formId!;

  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) });
  if (!form) throw new Response("Form not found", { status: 404 });

  const fields = await db
    .select({
      id: formFields.id,
      step: formFields.step,
      sortOrder: formFields.sortOrder,
      required: formFields.required,
      locked: formFields.locked,
      conditionalRule: formFields.conditionalRule,
      key: fieldDefinitions.key,
      label: fieldDefinitions.label,
      type: fieldDefinitions.type,
      options: fieldDefinitions.options,
      helpText: fieldDefinitions.helpText,
      defId: fieldDefinitions.id,
    })
    .from(formFields)
    .innerJoin(
      fieldDefinitions,
      eq(formFields.fieldDefinitionId, fieldDefinitions.id),
    )
    .where(eq(formFields.formId, formId))
    .orderBy(asc(formFields.sortOrder));

  const library = await db
    .select()
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.eventId, DEMO_EVENT_ID));

  return { form, fields, library, ms: Date.now() - started };
}

/* ------------------------------------------------------------------ *
 * Publish preflight. The organizer set a two-speaker minimum on his own
 * form, then hit the wall as a submitter and said "that was stupid".
 * Software should catch that before it traps anyone.
 * ------------------------------------------------------------------ */

type Warning = { level: "block" | "warn"; message: string; fix?: string };

function preflight(
  form: typeof forms.$inferSelect,
  fields: { label: string; type: string; options: unknown; required: boolean; step: string }[],
): Warning[] {
  const out: Warning[] = [];

  if (form.closeAt && new Date(form.closeAt).getTime() < Date.now()) {
    out.push({
      level: "block",
      message: "The close date is in the past, so nobody can submit.",
      fix: "Move the deadline forward or clear it.",
    });
  }

  for (const f of fields) {
    const isChoice = ["dropdown", "multiselect", "radio"].includes(f.type);
    if (isChoice && (!Array.isArray(f.options) || f.options.length === 0)) {
      out.push({
        level: "block",
        message: `"${f.label}" is a choice field with no options, so submitters cannot answer it.`,
        fix: "Add options in the field library, or remove the field.",
      });
    }
  }

  if (!fields.some((f) => f.step === "participant" && f.key === "email")) {
    out.push({
      level: "block",
      message: "No email field, so you will not be able to contact submitters.",
    });
  }

  if (form.submissionLimit && form.submissionLimit < 1) {
    out.push({
      level: "block",
      message: "The submission limit is below one, so every submitter is blocked.",
    });
  }

  const requiredCount = fields.filter((f) => f.required).length;
  if (requiredCount > 12) {
    out.push({
      level: "warn",
      message: `${requiredCount} required fields is a lot. Long forms lose submissions.`,
      fix: "Make the nice-to-haves optional and collect them later in the portal.",
    });
  }

  if (!form.closeAt) {
    out.push({
      level: "warn",
      message: "No close date set, so this form stays open indefinitely.",
    });
  }

  return out;
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const db = getDb(context);
  const formId = params.formId!;
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  if (intent === "save_settings") {
    const closeRaw = String(fd.get("closeAt") ?? "");
    const limitRaw = String(fd.get("submissionLimit") ?? "");
    await db
      .update(forms)
      .set({
        name: String(fd.get("name") ?? "Untitled form"),
        welcomeHtml: String(fd.get("welcomeHtml") ?? ""),
        successHtml: String(fd.get("successHtml") ?? ""),
        closeAt: closeRaw ? new Date(closeRaw) : null,
        submissionLimit: limitRaw ? Number(limitRaw) : null,
        allowMultipleDrafts: fd.get("allowMultipleDrafts") === "on",
        collectParticipants: fd.get("collectParticipants") === "on",
        updatedAt: new Date(),
      })
      .where(eq(forms.id, formId));
  }

  if (intent === "toggle_required") {
    const id = String(fd.get("fieldId"));
    const next = fd.get("next") === "1";
    await db.update(formFields).set({ required: next }).where(eq(formFields.id, id));
  }

  if (intent === "remove_field") {
    await db
      .delete(formFields)
      .where(
        and(
          eq(formFields.id, String(fd.get("fieldId"))),
          eq(formFields.locked, false),
        ),
      );
  }

  if (intent === "add_field") {
    const defId = String(fd.get("defId"));
    const step = String(fd.get("step")) as "submission" | "participant";
    const existing = await db
      .select({ sortOrder: formFields.sortOrder })
      .from(formFields)
      .where(eq(formFields.formId, formId));
    const max = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1);
    await db.insert(formFields).values({
      formId,
      fieldDefinitionId: defId,
      step,
      sortOrder: max + 1,
      required: false,
      locked: false,
    });
  }

  if (intent === "move_field") {
    const id = String(fd.get("fieldId"));
    const dir = Number(fd.get("dir"));
    const all = await db
      .select()
      .from(formFields)
      .where(eq(formFields.formId, formId))
      .orderBy(asc(formFields.sortOrder));
    const step = all.find((f) => f.id === id)?.step;
    const group = all.filter((f) => f.step === step);
    const i = group.findIndex((f) => f.id === id);
    const j = i + dir;
    if (i >= 0 && j >= 0 && j < group.length) {
      const a = group[i];
      const b = group[j];
      await db
        .update(formFields)
        .set({ sortOrder: b.sortOrder })
        .where(eq(formFields.id, a.id));
      await db
        .update(formFields)
        .set({ sortOrder: a.sortOrder })
        .where(eq(formFields.id, b.id));
    }
  }

  if (intent === "set_condition") {
    const id = String(fd.get("fieldId"));
    const fieldKey = String(fd.get("whenField") ?? "");
    const value = String(fd.get("whenValue") ?? "");
    await db
      .update(formFields)
      .set({
        conditionalRule:
          fieldKey && value ? { showIf: { fieldKey, op: "eq", value } } : null,
      })
      .where(eq(formFields.id, id));
  }

  if (intent === "publish") {
    await db.update(forms).set({ status: "open" }).where(eq(forms.id, formId));
  }

  return { ok: true };
}

function toDateInput(d: Date | string | null | undefined) {
  if (!d) return "";
  const date = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function FormBuilder() {
  const { form, fields, library, ms } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [openCond, setOpenCond] = useState<string | null>(null);

  const warnings = preflight(form as never, fields as never);
  const blockers = warnings.filter((w) => w.level === "block");

  const submissionFields = fields.filter((f) => f.step === "submission");
  const participantFields = fields.filter((f) => f.step === "participant");
  const usedDefIds = new Set(fields.map((f) => f.defId));

  // Only choice fields already on the form can drive a condition.
  const conditionSources = submissionFields.filter((f) =>
    ["dropdown", "radio", "multiselect"].includes(f.type),
  );

  const renderGroup = (
    list: typeof fields,
    step: "submission" | "participant",
    title: string,
    blurb: string,
  ) => (
    <section className="mb-8">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      <p className="mb-3 mt-0.5 text-[13px] text-slate-500">{blurb}</p>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {list.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-slate-500">
            No fields in this section yet. Add one below.
          </p>
        ) : (
          list.map((f, i) => {
            const rule = f.conditionalRule as
              | { showIf?: { fieldKey: string; value: string } }
              | null;
            return (
              <div
                key={f.id}
                className="border-b border-slate-100 px-4 py-2.5 last:border-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex flex-col">
                    <Form method="post">
                      <input type="hidden" name="intent" value="move_field" />
                      <input type="hidden" name="fieldId" value={f.id} />
                      <input type="hidden" name="dir" value="-1" />
                      <button
                        disabled={i === 0 || busy}
                        className="px-1 text-[10px] leading-none text-slate-400 hover:text-slate-900 disabled:opacity-30"
                        title="Move up"
                      >
                        ▲
                      </button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="move_field" />
                      <input type="hidden" name="fieldId" value={f.id} />
                      <input type="hidden" name="dir" value="1" />
                      <button
                        disabled={i === list.length - 1 || busy}
                        className="px-1 text-[10px] leading-none text-slate-400 hover:text-slate-900 disabled:opacity-30"
                        title="Move down"
                      >
                        ▼
                      </button>
                    </Form>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-slate-900">
                        {f.label}
                      </span>
                      {f.locked && (
                        <span
                          className="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500"
                          title="Built in field, cannot be removed"
                        >
                          built in
                        </span>
                      )}
                      {rule?.showIf && (
                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                          shows when {rule.showIf.fieldKey} = {rule.showIf.value}
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] text-slate-500">
                      {f.type}
                      {Array.isArray(f.options) && f.options.length > 0 && (
                        <> · {f.options.length} options</>
                      )}
                    </div>
                  </div>

                  <Form method="post" className="flex items-center">
                    <input type="hidden" name="intent" value="toggle_required" />
                    <input type="hidden" name="fieldId" value={f.id} />
                    <input
                      type="hidden"
                      name="next"
                      value={f.required ? "0" : "1"}
                    />
                    <button
                      className={[
                        "rounded-md px-2 py-1 text-[12px] font-medium",
                        f.required
                          ? "bg-slate-900 text-white hover:bg-slate-700"
                          : "border border-slate-300 text-slate-600 hover:bg-slate-50",
                      ].join(" ")}
                    >
                      {f.required ? "Required" : "Optional"}
                    </button>
                  </Form>

                  {step === "submission" && conditionSources.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setOpenCond(openCond === f.id ? null : f.id)
                      }
                      className="rounded-md border border-slate-300 px-2 py-1 text-[12px] text-slate-600 hover:bg-slate-50"
                    >
                      Logic
                    </button>
                  )}

                  {!f.locked && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove_field" />
                      <input type="hidden" name="fieldId" value={f.id} />
                      <button className="rounded-md px-2 py-1 text-[12px] text-slate-400 hover:bg-rose-50 hover:text-rose-700">
                        Remove
                      </button>
                    </Form>
                  )}
                </div>

                {openCond === f.id && (
                  <Form
                    method="post"
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2"
                  >
                    <input type="hidden" name="intent" value="set_condition" />
                    <input type="hidden" name="fieldId" value={f.id} />
                    <span className="text-[12px] text-slate-600">
                      Only show this field when
                    </span>
                    <select
                      name="whenField"
                      defaultValue={rule?.showIf?.fieldKey ?? ""}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[12px]"
                    >
                      <option value="">nothing (always show)</option>
                      {conditionSources
                        .filter((s) => s.id !== f.id)
                        .map((s) => (
                          <option key={s.id} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                    </select>
                    <span className="text-[12px] text-slate-600">is</span>
                    <input
                      name="whenValue"
                      defaultValue={rule?.showIf?.value ?? ""}
                      placeholder="Workshop (90 min)"
                      className="w-52 rounded border border-slate-300 bg-white px-2 py-1 text-[12px]"
                    />
                    <button className="rounded-md bg-slate-900 px-2 py-1 text-[12px] font-medium text-white hover:bg-slate-700">
                      Save rule
                    </button>
                  </Form>
                )}
              </div>
            );
          })
        )}
      </div>

      <Form method="post" className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="intent" value="add_field" />
        <input type="hidden" name="step" value={step} />
        <select
          name="defId"
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[13px]"
        >
          {library
            .filter((d) => !usedDefIds.has(d.id))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} ({d.type})
              </option>
            ))}
        </select>
        <button className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50">
          Add field
        </button>
      </Form>
    </section>
  );

  return (
    <div>
      <div className="border-b border-slate-200 bg-white px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <Link
              to="/admin/forms"
              className="text-[12px] text-slate-500 underline-offset-2 hover:underline"
            >
              Forms
            </Link>
            <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">
              {form.name}
            </h1>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Public link:{" "}
              <a
                href={`/submit/${form.publicSlug}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-indigo-700 underline underline-offset-2"
              >
                /submit/{form.publicSlug}
              </a>
            </p>
          </div>
          <div className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-500">
            {ms} ms
          </div>
        </div>
      </div>

      {/* Preflight */}
      {warnings.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2 text-[13px] font-medium">
            Before you publish
          </div>
          <ul className="divide-y divide-slate-100">
            {warnings.map((w, i) => (
              <li key={i} className="flex gap-2 px-4 py-2.5 text-[13px]">
                <span
                  className={[
                    "mt-0.5 h-2 w-2 shrink-0 rounded-full",
                    w.level === "block" ? "bg-rose-500" : "bg-amber-400",
                  ].join(" ")}
                />
                <div>
                  <div className="text-slate-900">{w.message}</div>
                  {w.fix && (
                    <div className="text-[12px] text-slate-500">{w.fix}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 border-t border-slate-100 px-4 py-2.5">
            <Form method="post">
              <input type="hidden" name="intent" value="publish" />
              <button
                disabled={blockers.length > 0 || busy}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Publish form
              </button>
            </Form>
            {blockers.length > 0 && (
              <span className="text-[12px] text-slate-500">
                {blockers.length} thing{blockers.length > 1 ? "s" : ""} to fix
                first
              </span>
            )}
          </div>
        </div>
      )}

      <div className="px-6 py-6">
        {renderGroup(
          submissionFields,
          "submission",
          "What you are collecting",
          "The proposal itself. Order here is the order submitters see.",
        )}
        {renderGroup(
          participantFields,
          "participant",
          "About the speaker",
          "Contact details and anything you need for the programme.",
        )}

        {/* Settings */}
        <section>
          <h2 className="text-[15px] font-semibold tracking-tight">Settings</h2>
          <p className="mb-3 mt-0.5 text-[13px] text-slate-500">
            Deadline, limits, and what submitters read.
          </p>

          <Form
            method="post"
            className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
          >
            <input type="hidden" name="intent" value="save_settings" />

            <label className="block">
              <span className="text-[13px] font-medium">Form name</span>
              <input
                name="name"
                defaultValue={form.name}
                className="mt-1 w-full max-w-md rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              />
            </label>

            <div className="flex flex-wrap gap-4">
              <label className="block">
                <span className="text-[13px] font-medium">Closes</span>
                <input
                  type="datetime-local"
                  name="closeAt"
                  defaultValue={toDateInput(form.closeAt)}
                  className="mt-1 block rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">
                  Submissions per person
                </span>
                <input
                  type="number"
                  min={1}
                  name="submissionLimit"
                  defaultValue={form.submissionLimit ?? ""}
                  placeholder="No limit"
                  className="mt-1 block w-40 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                />
              </label>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="allowMultipleDrafts"
                defaultChecked={form.allowMultipleDrafts}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="text-[13px]">
                Let people keep several drafts at once
              </span>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="collectParticipants"
                defaultChecked={form.collectParticipants}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="text-[13px]">Collect speaker details</span>
            </label>

            {/* Plain-English resolver for the settings that interact. */}
            <div className="rounded-md bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
              <div className="mb-0.5 font-medium text-slate-900">
                What submitters will experience
              </div>
              {form.submissionLimit
                ? `Each person can have ${form.submissionLimit} submission${form.submissionLimit > 1 ? "s" : ""} on this form, drafts included. `
                : "There is no cap on submissions per person. "}
              {form.allowMultipleDrafts
                ? "They can work on several drafts at once."
                : "They can only have one draft in progress, and must finish or delete it before starting another."}
              {form.closeAt
                ? ` The form stops accepting entries on ${new Date(form.closeAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`
                : " There is no deadline, so it stays open until you close it."}
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">Welcome message</span>
              <textarea
                name="welcomeHtml"
                rows={3}
                defaultValue={form.welcomeHtml ?? ""}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-[12px]"
              />
            </label>

            <label className="block">
              <span className="text-[13px] font-medium">
                Thank you message
              </span>
              <textarea
                name="successHtml"
                rows={2}
                defaultValue={form.successHtml ?? ""}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-[12px]"
              />
            </label>

            <button
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {busy ? "Saving" : "Save settings"}
            </button>
          </Form>
        </section>
      </div>
    </div>
  );
}
