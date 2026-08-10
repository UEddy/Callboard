import { useState } from "react";
import { Form, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { and, eq, asc, sql } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import {
  forms,
  formFields,
  fieldDefinitions,
  submissions,
  submissionParticipants,
  participants,
  events,
  tracks,
} from "~/db/schema";
import { readSession, writeSession } from "~/lib/session";
import { applyRoutingRules } from "~/lib/routing";
import { sendSubmissionConfirmation } from "~/lib/notify";

const STEPS = ["welcome", "account", "proposal", "speaker", "review"] as const;
type Step = (typeof STEPS)[number];

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);
  const step = (url.searchParams.get("step") ?? "welcome") as Step;

  const form = await db.query.forms.findFirst({
    where: eq(forms.publicSlug, params.slug!),
  });
  if (!form) throw new Response("Form not found", { status: 404 });

  const event = await db.query.events.findFirst({
    where: eq(events.id, form.eventId),
  });

  const closed =
    form.status !== "open" ||
    (form.closeAt ? new Date(form.closeAt).getTime() < Date.now() : false);

  const fields = await db
    .select({
      id: formFields.id,
      step: formFields.step,
      required: formFields.required,
      conditionalRule: formFields.conditionalRule,
      key: fieldDefinitions.key,
      label: fieldDefinitions.label,
      type: fieldDefinitions.type,
      options: fieldDefinitions.options,
      helpText: fieldDefinitions.helpText,
      validation: fieldDefinitions.validation,
    })
    .from(formFields)
    .innerJoin(
      fieldDefinitions,
      eq(formFields.fieldDefinitionId, fieldDefinitions.id),
    )
    .where(eq(formFields.formId, form.id))
    .orderBy(asc(formFields.sortOrder));

  const session = await readSession(request);

  let draft = null;
  let existingCount = 0;
  if (session.participantId) {
    const mine = await db
      .select({
        id: submissions.id,
        status: submissions.status,
        title: submissions.title,
        description: submissions.description,
        format: submissions.format,
        level: submissions.level,
        trackId: submissions.trackId,
        answers: submissions.answers,
      })
      .from(submissions)
      .innerJoin(
        submissionParticipants,
        eq(submissionParticipants.submissionId, submissions.id),
      )
      .where(
        and(
          eq(submissionParticipants.participantId, session.participantId),
          eq(submissions.formId, form.id),
        ),
      );
    existingCount = mine.length;
    draft = mine.find((m) => m.id === session.submissionId) ?? null;
  }

  const me = session.participantId
    ? await db.query.participants.findFirst({
        where: eq(participants.id, session.participantId),
      })
    : null;

  const trackList = await db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, form.eventId))
    .orderBy(tracks.sortOrder);

  return {
    form,
    event,
    fields,
    trackList,
    step,
    closed,
    draft,
    me,
    existingCount,
    ms: Date.now() - started,
  };
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const step = String(fd.get("step") ?? "welcome");

  const form = await db.query.forms.findFirst({
    where: eq(forms.publicSlug, params.slug!),
  });
  if (!form) throw new Response("Form not found", { status: 404 });

  const session = await readSession(request);
  const slug = params.slug!;

  /* --- Account: identify by email, create or resume a draft --------- */
  if (step === "account") {
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    const firstName = String(fd.get("firstName") ?? "").trim();
    const lastName = String(fd.get("lastName") ?? "").trim();
    if (!email) return { error: "Enter your email address." };

    let person = await db.query.participants.findFirst({
      where: and(
        eq(participants.eventId, form.eventId),
        eq(participants.email, email),
      ),
    });

    if (!person) {
      const id = crypto.randomUUID();
      await db.insert(participants).values({
        id,
        eventId: form.eventId,
        email,
        firstName: firstName || null,
        lastName: lastName || null,
      });
      person = { ...(person as never), id } as never;
    }

    const personId = (person as { id: string }).id;

    // Enforce the limit the builder set, drafts included.
    const mine = await db
      .select({ id: submissions.id, status: submissions.status })
      .from(submissions)
      .innerJoin(
        submissionParticipants,
        eq(submissionParticipants.submissionId, submissions.id),
      )
      .where(
        and(
          eq(submissionParticipants.participantId, personId),
          eq(submissions.formId, form.id),
        ),
      );

    const openDraft = mine.find((m) => m.status === "draft");

    if (!openDraft && form.submissionLimit && mine.length >= form.submissionLimit) {
      return {
        error: `You have reached the limit of ${form.submissionLimit} submission${form.submissionLimit > 1 ? "s" : ""} for this form.`,
      };
    }

    let submissionId = openDraft?.id;
    if (!submissionId) {
      const seqRow = await db
        .select({ max: sql<number>`coalesce(max(${submissions.refSeq}), 0)` })
        .from(submissions)
        .where(eq(submissions.eventId, form.eventId));
      const seq = Number(seqRow[0]?.max ?? 0) + 1;
      const prefix = form.kind === "abstracts" ? "ABS" : "SESS";
      submissionId = crypto.randomUUID();

      await db.insert(submissions).values({
        id: submissionId,
        eventId: form.eventId,
        formId: form.id,
        ref: `${prefix}-${seq}`,
        refSeq: seq,
        kind: form.kind,
        title: "",
        status: "draft",
        answers: {},
      });
      await db.insert(submissionParticipants).values({
        submissionId,
        participantId: personId,
        role: "Speaker",
        isPrimary: true,
        sortOrder: 0,
      });
    }

    return redirect(`/submit/${slug}?step=proposal`, {
      headers: {
        "Set-Cookie": await writeSession({
          participantId: personId,
          submissionId,
        }),
      },
    });
  }

  if (!session.submissionId) {
    return redirect(`/submit/${slug}?step=account`);
  }

  /* --- Proposal: core columns plus everything else into answers ----- */
  if (step === "proposal") {
    const answers: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) {
      if (["step", "title", "description", "format", "level", "track"].includes(k))
        continue;
      answers[k] = v;
    }
    const trackId = String(fd.get("track") ?? "");
    await db
      .update(submissions)
      .set({
        title: String(fd.get("title") ?? ""),
        description: String(fd.get("description") ?? ""),
        format: String(fd.get("format") ?? "") || null,
        level: String(fd.get("level") ?? "") || null,
        trackId: trackId || null,
        answers,
        updatedAt: new Date(),
      })
      .where(eq(submissions.id, session.submissionId));

    // Route on every save of this step, not just the first, so going back
    // and changing the format re-evaluates instead of leaving the
    // submission in a track chosen from an answer that no longer exists.
    // Routing is a convenience for the organiser: if it fails, the
    // submission is still saved and the producer can sort it out by hand.
    try {
      await applyRoutingRules(db, {
        eventId: form.eventId,
        formId: form.id,
        submissionId: session.submissionId,
      });
    } catch (e) {
      console.error("routing failed for", session.submissionId, e);
    }

    return redirect(`/submit/${slug}?step=speaker`);
  }

  if (step === "speaker") {
    await db
      .update(participants)
      .set({
        firstName: String(fd.get("first_name") ?? "") || null,
        lastName: String(fd.get("last_name") ?? "") || null,
        company: String(fd.get("company") ?? "") || null,
        jobTitle: String(fd.get("job_title") ?? "") || null,
        phone: String(fd.get("phone") ?? "") || null,
        bio: String(fd.get("bio") ?? "") || null,
        updatedAt: new Date(),
      })
      .where(eq(participants.id, session.participantId!));
    return redirect(`/submit/${slug}?step=review`);
  }

  if (step === "review") {
    await db
      .update(submissions)
      .set({ status: "pending", submittedAt: new Date(), updatedAt: new Date() })
      .where(eq(submissions.id, session.submissionId));

    // Acknowledge the submission. Deliberately after the status write and
    // deliberately not awaited into the redirect's success: the proposal
    // is already safe, so a mail problem must not show the submitter an
    // error on a submission that went through.
    if (session.participantId) {
      await sendSubmissionConfirmation(
        db,
        context.get(cloudflareContext).env,
        {
          submissionId: session.submissionId,
          participantId: session.participantId,
          origin: new URL(request.url).origin,
        },
      );
    }

    return redirect(`/submit/${slug}?step=done`, {
      headers: {
        "Set-Cookie": await writeSession({
          participantId: session.participantId,
        }),
      },
    });
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */

const input =
  "mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] outline-none placeholder:text-faint focus:border-accent-solid focus:ring-4 focus:ring-accent-ring";

export default function Submit() {
  const {
    form,
    event,
    fields,
    trackList,
    step,
    closed,
    draft,
    me,
    existingCount,
    ms,
  } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  // Live values drive the conditional rules as the submitter types.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const answers = (draft?.answers ?? {}) as Record<string, string>;
    return {
      title: draft?.title ?? "",
      description: draft?.description ?? "",
      format: draft?.format ?? "",
      level: draft?.level ?? "",
      track: draft?.trackId ?? "",
      ...answers,
    };
  });

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const visible = (f: (typeof fields)[number]) => {
    const rule = f.conditionalRule as
      | { showIf?: { fieldKey: string; value: string } }
      | null;
    if (!rule?.showIf) return true;
    return values[rule.showIf.fieldKey] === rule.showIf.value;
  };

  const proposalFields = fields.filter((f) => f.step === "submission");
  const speakerFields = fields.filter((f) => f.step === "participant");

  const stepIndex = STEPS.indexOf(step as Step);

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6">
          <div className="text-[13px] font-medium uppercase tracking-[0.1em] text-dim">
            {event?.name}
          </div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight text-strong">
            {form.name}
          </h1>
        </div>

        {step !== "done" && !closed && (
          <ol className="mb-6 flex flex-wrap gap-x-2 gap-y-1 text-[12px]">
            {STEPS.map((s, i) => (
              <li
                key={s}
                className={[
                  "flex items-center gap-1.5",
                  i <= stepIndex ? "text-strong" : "text-faint",
                ].join(" ")}
              >
                <span
                  className={[
                    "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium",
                    i < stepIndex
                      ? "bg-success-solid text-on-solid"
                      : i === stepIndex
                        ? "bg-invert text-invert-fg"
                        : "bg-muted-strong text-body",
                  ].join(" ")}
                >
                  {i < stepIndex ? "✓" : i + 1}
                </span>
                <span className="capitalize">{s}</span>
                {i < STEPS.length - 1 && (
                  <span className="ml-1 text-faint">→</span>
                )}
              </li>
            ))}
          </ol>
        )}

        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
          {children}
        </div>

        <div className="mt-4 flex justify-between text-[12px] text-faint">
          <span>Powered by Callboard</span>
          <span className="font-mono tabular-nums">{ms} ms</span>
        </div>
      </div>
    </div>
  );

  if (closed) {
    return shell(
      <div className="py-6 text-center">
        <h2 className="text-[18px] font-semibold">Submissions are closed</h2>
        <p className="mt-1 text-[14px] text-dim">
          {form.closeAt
            ? `This form stopped accepting entries on ${new Date(form.closeAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`
            : "This form is not accepting entries right now."}
        </p>
      </div>,
    );
  }

  if (step === "done") {
    return shell(
      <div className="py-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-success-solid text-[18px] text-on-solid">
          ✓
        </div>
        <h2 className="text-[18px] font-semibold">You are in</h2>
        <div
          className="mt-2 text-[14px] text-body"
          dangerouslySetInnerHTML={{ __html: form.successHtml ?? "" }}
        />
      </div>,
    );
  }

  if (step === "welcome") {
    return shell(
      <div>
        <div
          className="prose-sm text-[14px] leading-relaxed text-body"
          dangerouslySetInnerHTML={{ __html: form.welcomeHtml ?? "" }}
        />
        <dl className="mt-4 space-y-1 border-t border-line-soft pt-4 text-[13px]">
          {form.closeAt && (
            <div className="flex gap-2">
              <dt className="text-dim">Deadline</dt>
              <dd className="font-medium">
                {new Date(form.closeAt).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </dd>
            </div>
          )}
          {form.submissionLimit && (
            <div className="flex gap-2">
              <dt className="text-dim">Limit</dt>
              <dd className="font-medium">
                {form.submissionLimit} per person, drafts included
              </dd>
            </div>
          )}
        </dl>
        <a
          href="?step=account"
          className="mt-5 inline-block rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover"
        >
          Start
        </a>
      </div>,
    );
  }

  if (step === "account") {
    return shell(
      <Form method="post" className="space-y-4">
        <input type="hidden" name="step" value="account" />
        <div>
          <h2 className="text-[16px] font-semibold">Who are you?</h2>
          <p className="mt-0.5 text-[13px] text-dim">
            We use your email to save your progress. No password needed.
          </p>
        </div>
        <label className="block">
          <span className="text-[13px] font-medium">Email</span>
          <input
            name="email"
            type="email"
            required
            defaultValue={me?.email ?? ""}
            className={input}
            placeholder="you@company.com"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[13px] font-medium">First name</span>
            <input name="firstName" defaultValue={me?.firstName ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Last name</span>
            <input name="lastName" defaultValue={me?.lastName ?? ""} className={input} />
          </label>
        </div>
        {existingCount > 0 && (
          <p className="rounded-lg bg-subtle px-3 py-2 text-[13px] text-body">
            You already have {existingCount} submission
            {existingCount > 1 ? "s" : ""} on this form. We will pick up your
            draft if you have one.
          </p>
        )}
        <button
          disabled={busy}
          className="rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
        >
          {busy ? "Working" : "Continue"}
        </button>
      </Form>,
    );
  }

  if (step === "proposal") {
    return shell(
      <Form method="post" className="space-y-4">
        <input type="hidden" name="step" value="proposal" />
        <h2 className="text-[16px] font-semibold">Your proposal</h2>

        {proposalFields.map((f) => {
          if (!visible(f)) return null;
          const name = f.key === "track" ? "track" : f.key;
          const common = {
            name,
            required: f.required,
            value: values[name] ?? "",
            onChange: (
              e: React.ChangeEvent<
                HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
              >,
            ) => set(name, e.target.value),
            className: input,
          };
          return (
            <label key={f.id} className="block">
              <span className="text-[13px] font-medium">
                {f.label}
                {f.required && <span className="text-danger"> *</span>}
              </span>
              {f.helpText && (
                <span className="block text-[12px] text-dim">
                  {f.helpText}
                </span>
              )}

              {f.key === "track" ? (
                <select {...common}>
                  <option value="">Choose a track</option>
                  {trackList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              ) : ["dropdown", "radio"].includes(f.type) ? (
                <select {...common}>
                  <option value="">Choose one</option>
                  {(f.options as string[] | null)?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : ["textarea", "wysiwyg"].includes(f.type) ? (
                <textarea {...common} rows={f.type === "wysiwyg" ? 6 : 3} />
              ) : (
                <input
                  {...common}
                  type={f.type === "number" ? "number" : "text"}
                />
              )}
            </label>
          );
        })}

        <div className="flex gap-2">
          <a
            href="?step=account"
            className="rounded-lg border border-line-strong px-4 py-2 text-[14px] text-body hover:bg-subtle"
          >
            Back
          </a>
          <button
            disabled={busy}
            className="rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
          >
            {busy ? "Saving" : "Save and continue"}
          </button>
        </div>
        <p className="text-[12px] text-faint">
          Saved as you go. You can close this and come back.
        </p>
      </Form>,
    );
  }

  if (step === "speaker") {
    return shell(
      <Form method="post" className="space-y-4">
        <input type="hidden" name="step" value="speaker" />
        <h2 className="text-[16px] font-semibold">About you</h2>
        {speakerFields.map((f) => (
          <label key={f.id} className="block">
            <span className="text-[13px] font-medium">
              {f.label}
              {f.required && <span className="text-danger"> *</span>}
            </span>
            {f.helpText && (
              <span className="block text-[12px] text-dim">
                {f.helpText}
              </span>
            )}
            {["textarea", "wysiwyg"].includes(f.type) ? (
              <textarea
                name={f.key}
                required={f.required}
                rows={5}
                defaultValue={
                  (me?.[f.key as keyof typeof me] as string | null) ?? ""
                }
                className={input}
              />
            ) : (
              <input
                name={f.key}
                type={f.type === "email" ? "email" : "text"}
                required={f.required}
                readOnly={f.key === "email"}
                defaultValue={
                  (me?.[f.key as keyof typeof me] as string | null) ?? ""
                }
                className={`${input} ${f.key === "email" ? "bg-subtle text-dim" : ""}`}
              />
            )}
          </label>
        ))}
        <div className="flex gap-2">
          <a
            href="?step=proposal"
            className="rounded-lg border border-line-strong px-4 py-2 text-[14px] text-body hover:bg-subtle"
          >
            Back
          </a>
          <button
            disabled={busy}
            className="rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
          >
            {busy ? "Saving" : "Save and continue"}
          </button>
        </div>
      </Form>,
    );
  }

  // review
  const trackName = trackList.find((t) => t.id === draft?.trackId)?.name;
  return shell(
    <Form method="post" className="space-y-4">
      <input type="hidden" name="step" value="review" />
      <h2 className="text-[16px] font-semibold">Check it over</h2>

      <dl className="divide-y divide-line-soft rounded-lg border border-line">
        {[
          ["Title", draft?.title],
          ["Format", draft?.format],
          ["Track", trackName],
          ["Level", draft?.level],
          ["Speaker", [me?.firstName, me?.lastName].filter(Boolean).join(" ")],
          ["Email", me?.email],
          ["Company", me?.company],
        ].map(([k, v]) => (
          <div key={k as string} className="flex gap-4 px-3 py-2">
            <dt className="w-24 shrink-0 text-[13px] text-dim">{k}</dt>
            <dd className="text-[13px] font-medium text-strong">
              {v || <span className="font-normal text-faint">Not set</span>}
            </dd>
          </div>
        ))}
      </dl>

      {draft?.description && (
        <div>
          <div className="text-[13px] text-dim">Description</div>
          <div className="mt-1 whitespace-pre-wrap rounded-lg bg-subtle px-3 py-2 text-[13px] text-strong">
            {draft.description}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <a
          href="?step=speaker"
          className="rounded-lg border border-line-strong px-4 py-2 text-[14px] text-body hover:bg-subtle"
        >
          Back
        </a>
        <button
          disabled={busy}
          className="rounded-lg bg-success-solid px-4 py-2 text-[14px] font-medium text-on-solid hover:bg-success-solid disabled:opacity-50"
        >
          {busy ? "Submitting" : "Submit proposal"}
        </button>
      </div>
    </Form>,
  );
}
