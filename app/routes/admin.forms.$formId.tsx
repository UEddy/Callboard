import { useState } from "react";
import { Form, Link, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { eq, and, asc } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import { events, forms, formFields, fieldDefinitions, personas } from "~/db/schema";
import {
  DEFAULT_ROLES,
  describeRoles,
  parseRoles,
  plural,
  type RoleRule,
} from "~/lib/participants";
import {
  fmtDateIn,
  fromZonedInput,
  safeZone,
  toZonedInput,
  zoneAbbr,
} from "~/lib/tz";

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

  const personaList = await db
    .select({ id: personas.id, name: personas.name })
    .from(personas)
    .where(eq(personas.eventId, DEMO_EVENT_ID));

  /* The deadline is a moment in the event's timezone, not the
     producer's, so the builder has to know which zone that is before it
     can render or accept one. */
  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  const zone = safeZone(event?.timezone);
  const closeAtMs = form.closeAt ? new Date(form.closeAt).getTime() : null;

  return {
    form,
    fields,
    library,
    personaList,
    eventZone: zone,
    zoneLabel: zoneAbbr(closeAtMs ?? Date.now(), zone),
    closeAtInput: toZonedInput(closeAtMs, zone),
    closeAtLabel: closeAtMs
      ? `${fmtDateIn(closeAtMs, zone, { month: "long", day: "numeric", year: "numeric" })} at ${new Intl.DateTimeFormat(
          "en-US",
          { hour: "numeric", minute: "2-digit", timeZone: zone },
        ).format(closeAtMs)} ${zoneAbbr(closeAtMs, zone)}`
      : null,
    roles: parseRoles(form.participantRoles),
    ms: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ *
 * Publish preflight. The organizer set a two-speaker minimum on his own
 * form, then hit the wall as a submitter and said "that was stupid".
 * Software should catch that before it traps anyone.
 * ------------------------------------------------------------------ */

type Warning = { level: "block" | "warn"; message: string; fix?: string };

function preflight(
  form: typeof forms.$inferSelect,
  fields: {
    label: string;
    type: string;
    options: unknown;
    required: boolean;
    step: string;
    key: string;
  }[],
): Warning[] {
  const out: Warning[] = [];

  /* The mistake this whole preflight exists for. Requiring two of any
     role means a person submitting on their own cannot get past the
     participant step, and they find out only after writing the
     proposal. Nothing in the admin ever shows you the people who gave
     up, so this has to be caught here. */
  for (const r of parseRoles(form.participantRoles)) {
    if (r.min > 1) {
      out.push({
        level: "block",
        message: `You are requiring at least ${r.min} ${plural(r.role, r.min)} on every submission. Anyone submitting on their own will be blocked at the participant step, after they have already written their proposal.`,
        fix: `Set the minimum for ${plural(r.role, 2)} to 1 and let submitters add more if they have them.`,
      });
    }
  }

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
    /* Read against the event's zone, the same way Settings does and the
       same way the field is labelled. `new Date("2026-10-01T17:00")`
       would have used whatever zone the server happens to run in, which
       on Workers is UTC and is nobody's deadline. */
    const ev = await db.query.events.findFirst({
      where: eq(events.id, DEMO_EVENT_ID),
    });
    const closeAt = fromZonedInput(closeRaw, safeZone(ev?.timezone));
    await db
      .update(forms)
      .set({
        name: String(fd.get("name") ?? "Untitled form"),
        welcomeHtml: String(fd.get("welcomeHtml") ?? ""),
        successHtml: String(fd.get("successHtml") ?? ""),
        closeAt: closeAt,
        submissionLimit: limitRaw ? Number(limitRaw) : null,
        allowMultipleDrafts: fd.get("allowMultipleDrafts") === "on",
        collectParticipants: fd.get("collectParticipants") === "on",
        confirmSubmitter: fd.get("confirmSubmitter") === "on",
        autoRedirectToPortal: fd.get("autoRedirectToPortal") === "on",
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

  if (intent === "save_participants") {
    /* One row per persona. An unchecked persona is simply absent from
       the saved rules, so it never appears on the public form. */
    const rules: RoleRule[] = [];
    for (const role of fd.getAll("role") as string[]) {
      if (fd.get(`enabled_${role}`) !== "on") continue;
      const min = Number(fd.get(`min_${role}`) ?? 0);
      const rawMax = String(fd.get(`max_${role}`) ?? "").trim();
      rules.push({
        role,
        min: Number.isFinite(min) ? Math.max(0, Math.trunc(min)) : 0,
        max: rawMax === "" ? null : Math.max(0, Math.trunc(Number(rawMax))),
      });
    }

    const capRaw = String(fd.get("participantCap") ?? "").trim();

    await db
      .update(forms)
      .set({
        participantRoles: rules.length ? rules : DEFAULT_ROLES,
        participantCap: capRaw === "" ? null : Math.max(1, Number(capRaw)),
        updatedAt: new Date(),
      })
      .where(eq(forms.id, formId));
  }

  if (intent === "publish") {
    /* Re-run the preflight here rather than trusting the disabled button.
       A blocker that only exists in the browser is not a blocker, and
       this one exists to stop a form going live that no solo submitter
       can complete. */
    const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) });
    if (!form) throw new Response("Form not found", { status: 404 });

    const current = await db
      .select({
        label: fieldDefinitions.label,
        type: fieldDefinitions.type,
        options: fieldDefinitions.options,
        key: fieldDefinitions.key,
        required: formFields.required,
        step: formFields.step,
      })
      .from(formFields)
      .innerJoin(
        fieldDefinitions,
        eq(formFields.fieldDefinitionId, fieldDefinitions.id),
      )
      .where(eq(formFields.formId, formId));

    const blockers = preflight(form, current as never).filter(
      (w) => w.level === "block",
    );
    if (blockers.length > 0) {
      return {
        publishRefused: blockers.map((b) => b.message),
      };
    }

    await db.update(forms).set({ status: "open" }).where(eq(forms.id, formId));
  }

  return { ok: true };
}

export default function FormBuilder() {
  const {
    form,
    fields,
    library,
    personaList,
    roles,
    zoneLabel,
    closeAtInput,
    closeAtLabel,
    ms,
  } = useLoaderData<typeof loader>();
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
      <p className="mb-3 mt-0.5 text-[13px] text-dim">{blurb}</p>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {list.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-dim">
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
                className="border-b border-line-soft px-4 py-2.5 last:border-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex flex-col">
                    <Form method="post">
                      <input type="hidden" name="intent" value="move_field" />
                      <input type="hidden" name="fieldId" value={f.id} />
                      <input type="hidden" name="dir" value="-1" />
                      <button
                        disabled={i === 0 || busy}
                        className="px-1 text-[10px] leading-none text-faint hover:text-strong disabled:opacity-30"
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
                        className="px-1 text-[10px] leading-none text-faint hover:text-strong disabled:opacity-30"
                        title="Move down"
                      >
                        ▼
                      </button>
                    </Form>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-strong">
                        {f.label}
                      </span>
                      {f.locked && (
                        <span
                          className="rounded bg-muted px-1 py-0.5 text-[10px] text-dim"
                          title="Built in field, cannot be removed"
                        >
                          built in
                        </span>
                      )}
                      {rule?.showIf && (
                        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
                          shows when {rule.showIf.fieldKey} = {rule.showIf.value}
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] text-dim">
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
                          ? "bg-invert text-invert-fg hover:bg-invert-hover"
                          : "border border-line-strong text-body hover:bg-subtle",
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
                      className="rounded-md border border-line-strong px-2 py-1 text-[12px] text-body hover:bg-subtle"
                    >
                      Logic
                    </button>
                  )}

                  {!f.locked && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove_field" />
                      <input type="hidden" name="fieldId" value={f.id} />
                      <button className="rounded-md px-2 py-1 text-[12px] text-faint hover:bg-danger-soft hover:text-danger">
                        Remove
                      </button>
                    </Form>
                  )}
                </div>

                {openCond === f.id && (
                  <Form
                    method="post"
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-subtle px-3 py-2"
                  >
                    <input type="hidden" name="intent" value="set_condition" />
                    <input type="hidden" name="fieldId" value={f.id} />
                    <span className="text-[12px] text-body">
                      Only show this field when
                    </span>
                    <select
                      name="whenField"
                      defaultValue={rule?.showIf?.fieldKey ?? ""}
                      className="rounded border border-line-strong bg-surface px-2 py-1 text-[12px]"
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
                    <span className="text-[12px] text-body">is</span>
                    <input
                      name="whenValue"
                      defaultValue={rule?.showIf?.value ?? ""}
                      placeholder="Workshop (90 min)"
                      className="w-52 rounded border border-line-strong bg-surface px-2 py-1 text-[12px]"
                    />
                    <button className="rounded-md bg-invert px-2 py-1 text-[12px] font-medium text-invert-fg hover:bg-invert-hover">
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
          className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[13px]"
        >
          {library
            .filter((d) => !usedDefIds.has(d.id))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} ({d.type})
              </option>
            ))}
        </select>
        <button className="rounded-md border border-line-strong px-2.5 py-1.5 text-[13px] font-medium text-body hover:bg-subtle">
          Add field
        </button>
        <Link
          to="/admin/library?tab=fields"
          prefetch="intent"
          className="self-center text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
        >
          Manage the field library
        </Link>
      </Form>
    </section>
  );

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <Link
              to="/admin/forms"
              className="text-[12px] text-dim underline-offset-2 hover:underline"
            >
              Forms
            </Link>
            <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">
              {form.name}
            </h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Public link:{" "}
              <a
                href={`/submit/${form.publicSlug}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent-text underline underline-offset-2"
              >
                /submit/{form.publicSlug}
              </a>
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim" title="Time spent in this page's loader fetching data. It excludes rendering, so it is not total server time: that is in the Server-Timing response header.">
            data {ms} ms
          </div>
        </div>
      </div>

      {/* Preflight */}
      {warnings.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-line bg-surface">
          <div className="border-b border-line-soft px-4 py-2 text-[13px] font-medium">
            Before you publish
          </div>
          <ul className="divide-y divide-line-soft">
            {warnings.map((w, i) => (
              <li key={i} className="flex gap-2 px-4 py-2.5 text-[13px]">
                <span
                  className={[
                    "mt-0.5 h-2 w-2 shrink-0 rounded-full",
                    w.level === "block" ? "bg-danger-solid" : "bg-warn-solid",
                  ].join(" ")}
                />
                <div>
                  <div className="text-strong">{w.message}</div>
                  {w.fix && (
                    <div className="text-[12px] text-dim">{w.fix}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 border-t border-line-soft px-4 py-2.5">
            <Form method="post">
              <input type="hidden" name="intent" value="publish" />
              <button
                disabled={blockers.length > 0 || busy}
                className="rounded-md bg-invert px-3 py-1.5 text-[13px] font-medium text-invert-fg hover:bg-invert-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Publish form
              </button>
            </Form>
            {blockers.length > 0 && (
              <span className="text-[12px] text-dim">
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
          "Participant information",
          "Contact details and anything you need for the programme. These fields are asked for each person on the submission.",
        )}

        {/* Who may be added */}
        <section className="mb-8">
          <h2 className="text-[15px] font-semibold tracking-tight">
            Who submitters can add
          </h2>
          <p className="mb-3 mt-0.5 text-[13px] text-dim">
            The submitter is always added as the primary Speaker. These rules
            govern anyone else they put on the submission. Roles come from the{" "}
            <Link
              to="/admin/library?tab=personas"
              className="text-accent-text underline underline-offset-2"
            >
              persona library
            </Link>
            .
          </p>

          <Form
            method="post"
            className="space-y-4 rounded-lg border border-line bg-surface p-4"
          >
            <input type="hidden" name="intent" value="save_participants" />

            <div className="overflow-hidden rounded-md border border-line">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="cb-thead text-[11px] uppercase tracking-[0.06em]">
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="w-28 px-3 py-2 font-medium">Minimum</th>
                    <th className="w-28 px-3 py-2 font-medium">Maximum</th>
                  </tr>
                </thead>
                <tbody>
                  {personaList.map((p) => {
                    const rule = roles.find((r) => r.role === p.name);
                    return (
                      <tr
                        key={p.id}
                        className="border-b border-line-soft last:border-0"
                      >
                        <td className="px-3 py-2">
                          <input type="hidden" name="role" value={p.name} />
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              name={`enabled_${p.name}`}
                              defaultChecked={Boolean(rule)}
                              className="h-4 w-4 rounded border-line-strong"
                            />
                            <span className="text-strong">{p.name}</span>
                          </label>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            name={`min_${p.name}`}
                            defaultValue={rule?.min ?? 0}
                            className="w-20 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            name={`max_${p.name}`}
                            defaultValue={rule?.max ?? ""}
                            placeholder="No limit"
                            className="w-24 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">
                Total people per submission
              </span>
              <span className="block text-[12px] text-dim">
                Across all roles. Leave blank for no overall cap.
              </span>
              <input
                type="number"
                min={1}
                name="participantCap"
                defaultValue={form.participantCap ?? ""}
                placeholder="No cap"
                className="mt-1 w-32 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong"
              />
            </label>

            {/* Same resolver idea as the settings block: read the effect
                back, not the numbers. */}
            <div className="rounded-md bg-subtle px-3 py-2 text-[12px] text-body">
              <div className="mb-0.5 font-medium text-strong">
                What submitters will experience
              </div>
              {describeRoles(roles, form.participantCap)}
              {roles.some((r) => r.min > 1) && (
                <span className="mt-1 block font-medium text-danger">
                  A minimum above one blocks anyone submitting alone. Publishing
                  is disabled until you lower it.
                </span>
              )}
            </div>

            <button
              disabled={busy}
              className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
            >
              {busy ? "Saving" : "Save participant rules"}
            </button>
          </Form>
        </section>

        {/* Settings */}
        <section>
          <h2 className="text-[15px] font-semibold tracking-tight">Settings</h2>
          <p className="mb-3 mt-0.5 text-[13px] text-dim">
            Deadline, limits, and what submitters read.
          </p>

          <Form
            method="post"
            className="space-y-4 rounded-lg border border-line bg-surface p-4"
          >
            <input type="hidden" name="intent" value="save_settings" />

            <label className="block">
              <span className="text-[13px] font-medium">Form name</span>
              <input
                name="name"
                defaultValue={form.name}
                className="mt-1 w-full max-w-md rounded-md border border-line-strong px-2.5 py-1.5 text-[13px] focus:border-accent-solid focus:ring-2 focus:ring-accent-ring"
              />
            </label>

            <div className="flex flex-wrap gap-4">
              <label className="block">
                <span className="text-[13px] font-medium">
                  Closes{" "}
                  <span className="font-normal text-dim">
                    ({zoneLabel}, the event's time)
                  </span>
                </span>
                <input
                  type="datetime-local"
                  name="closeAt"
                  defaultValue={closeAtInput}
                  className="mt-1 block rounded-md border border-line-strong px-2.5 py-1.5 text-[13px]"
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
                  className="mt-1 block w-40 rounded-md border border-line-strong px-2.5 py-1.5 text-[13px]"
                />
              </label>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="allowMultipleDrafts"
                defaultChecked={form.allowMultipleDrafts}
                className="h-4 w-4 rounded border-line-strong"
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
                className="h-4 w-4 rounded border-line-strong"
              />
              <span className="text-[13px]">Collect speaker details</span>
            </label>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="autoRedirectToPortal"
                defaultChecked={form.autoRedirectToPortal}
                className="mt-0.5 h-4 w-4 rounded border-line-strong"
              />
              <span className="text-[13px]">
                Send submitters to their portal when they finish
                <span className="block text-[12px] text-dim">
                  The thank you message shows with a ten second countdown and a
                  link that goes immediately, then they land in the portal
                  already signed in. Off means a Continue button instead, and
                  nothing moves on its own.
                </span>
              </span>
            </label>

            {/* Notifications */}
            <div className="border-t border-line-soft pt-4">
              <div className="text-[13px] font-medium">Notifications</div>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  name="confirmSubmitter"
                  defaultChecked={form.confirmSubmitter}
                  className="mt-0.5 h-4 w-4 rounded border-line-strong"
                />
                <span className="text-[13px]">
                  Email submitters a confirmation
                  <span className="block text-[12px] text-dim">
                    Sent when they finish, with their reference and a link
                    straight into the speaker portal. Turning this off means a
                    submitter gets no acknowledgement at all, and the usual
                    result is a duplicate submission a week later.
                  </span>
                </span>
              </label>
              {Array.isArray(form.adminNotifyNew) &&
                form.adminNotifyNew.length > 0 && (
                  <p className="mt-2 text-[12px] text-dim">
                    New submissions also notify {form.adminNotifyNew.join(", ")}.
                  </p>
                )}
            </div>

            {/* Plain-English resolver for the settings that interact. */}
            <div className="rounded-md bg-subtle px-3 py-2 text-[12px] text-body">
              <div className="mb-0.5 font-medium text-strong">
                What submitters will experience
              </div>
              {form.submissionLimit
                ? `Each person can have ${form.submissionLimit} submission${form.submissionLimit > 1 ? "s" : ""} on this form, drafts included. `
                : "There is no cap on submissions per person. "}
              {form.allowMultipleDrafts
                ? "They can work on several drafts at once."
                : "They can only have one draft in progress, and must finish or delete it before starting another."}
              {closeAtLabel
                ? ` The form stops accepting entries on ${closeAtLabel}.`
                : " There is no deadline, so it stays open until you close it."}
              {form.autoRedirectToPortal
                ? " When they finish, they are sent to their speaker portal after a ten second countdown, already signed in."
                : " When they finish, they stay on the thank you page until they press Continue."}
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">Welcome message</span>
              <textarea
                name="welcomeHtml"
                rows={3}
                defaultValue={form.welcomeHtml ?? ""}
                className="mt-1 w-full rounded-md border border-line-strong px-2.5 py-1.5 font-mono text-[12px]"
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
                className="mt-1 w-full rounded-md border border-line-strong px-2.5 py-1.5 font-mono text-[12px]"
              />
            </label>

            <button
              disabled={busy}
              className="rounded-md bg-invert px-3 py-1.5 text-[13px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
            >
              {busy ? "Saving" : "Save settings"}
            </button>
          </Form>
        </section>
      </div>
    </div>
  );
}
