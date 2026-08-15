import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
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
import { readSession, writePortal, writeSession } from "~/lib/session";
import {
  addableRoles,
  describeRoles,
  parseRoles,
  plural,
  validateParticipants,
  type ParticipantIssue,
} from "~/lib/participants";
import { sendSubmissionConfirmation } from "~/lib/notify";
import { formIsOpen, readProposal, saveProposal } from "~/lib/proposal";
import {
  ProposalFields,
  initialProposalValues,
  type ProposalValues,
} from "~/components/ProposalFields";
import { publicBaseUrl } from "~/lib/base-url";

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

  const closed = !formIsOpen(form);

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

  /* Everyone currently on this submission, primary first. */
  const roster = session.submissionId
    ? await db
        .select({
          linkId: submissionParticipants.id,
          role: submissionParticipants.role,
          isPrimary: submissionParticipants.isPrimary,
          sortOrder: submissionParticipants.sortOrder,
          id: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
          email: participants.email,
          company: participants.company,
          jobTitle: participants.jobTitle,
          bio: participants.bio,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(eq(submissionParticipants.submissionId, session.submissionId))
        .orderBy(asc(submissionParticipants.sortOrder))
    : [];

  const roles = parseRoles(form.participantRoles);
  const counts: Record<string, number> = {};
  for (const r of roster) counts[r.role] = (counts[r.role] ?? 0) + 1;

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
    roster: [...roster].sort(
      (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder,
    ),
    roles,
    participantCap: form.participantCap,
    addable: addableRoles(roles, counts, form.participantCap, roster.length),
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
    // Shared with the portal's edit form, so the two write the same
    // columns and re-run routing the same way.
    await saveProposal(db, {
      submissionId: session.submissionId,
      eventId: form.eventId,
      formId: form.id,
      patch: readProposal(fd),
    });

    return redirect(`/submit/${slug}?step=speaker`);
  }

  if (step === "speaker") {
    const pIntent = String(fd.get("pIntent") ?? "continue");
    const rules = parseRoles(form.participantRoles);

    const roster = await db
      .select({
        linkId: submissionParticipants.id,
        participantId: submissionParticipants.participantId,
        role: submissionParticipants.role,
        isPrimary: submissionParticipants.isPrimary,
      })
      .from(submissionParticipants)
      .where(eq(submissionParticipants.submissionId, session.submissionId));

    const counts: Record<string, number> = {};
    for (const r of roster) counts[r.role] = (counts[r.role] ?? 0) + 1;

    /* --- the submitter's own details -------------------------------- */
    if (pIntent === "save_self") {
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
      return { savedSelf: true };
    }

    /* --- add a co participant --------------------------------------- */
    if (pIntent === "add") {
      const email = String(fd.get("email") ?? "").trim().toLowerCase();
      const firstName = String(fd.get("first_name") ?? "").trim();
      const lastName = String(fd.get("last_name") ?? "").trim();
      const role = String(fd.get("role") ?? "").trim();

      if (!email) return { addError: "Enter an email address for this person." };
      if (!firstName)
        return { addError: "Enter a first name for this person." };
      if (!rules.some((r) => r.role === role))
        return { addError: "Choose a role for this person." };

      const rule = rules.find((r) => r.role === role)!;
      const have = counts[role] ?? 0;
      if (rule.max !== null && have >= rule.max) {
        return {
          addError: `This form allows at most ${rule.max} ${plural(role, rule.max)}, and you already have ${have}.`,
        };
      }
      if (
        form.participantCap !== null &&
        roster.length >= form.participantCap
      ) {
        return {
          addError: `This form allows at most ${form.participantCap} people in total, and you already have ${roster.length}.`,
        };
      }

      // Reuse the person if this event already knows them, so the same
      // human is not duplicated across submissions.
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
          company: String(fd.get("company") ?? "").trim() || null,
          jobTitle: String(fd.get("job_title") ?? "").trim() || null,
          bio: String(fd.get("bio") ?? "").trim() || null,
        });
        person = { id } as never;
      } else {
        // Fill in blanks without clobbering what they already have.
        await db
          .update(participants)
          .set({
            firstName: person.firstName ?? firstName ?? null,
            lastName: person.lastName ?? lastName ?? null,
            company:
              person.company ?? String(fd.get("company") ?? "").trim() ?? null,
            jobTitle:
              person.jobTitle ??
              String(fd.get("job_title") ?? "").trim() ??
              null,
            bio: person.bio ?? String(fd.get("bio") ?? "").trim() ?? null,
            updatedAt: new Date(),
          })
          .where(eq(participants.id, person.id));
      }

      const personId = (person as { id: string }).id;
      if (roster.some((r) => r.participantId === personId)) {
        return { addError: `${email} is already on this submission.` };
      }

      await db.insert(submissionParticipants).values({
        submissionId: session.submissionId,
        participantId: personId,
        role,
        isPrimary: false,
        sortOrder: roster.length,
      });
      return { added: true };
    }

    /* --- remove a co participant ------------------------------------ */
    if (pIntent === "remove") {
      const linkId = String(fd.get("linkId") ?? "");
      const target = roster.find((r) => r.linkId === linkId);
      // The submitter cannot remove themselves: they own the submission.
      if (target && !target.isPrimary) {
        await db
          .delete(submissionParticipants)
          .where(eq(submissionParticipants.id, linkId));
      }
      return { removed: true };
    }

    /* --- continue: enforce the configured minimums ------------------- */
    const issues = validateParticipants(rules, form.participantCap, counts);
    if (issues.length > 0) return { participantIssues: issues };

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
          origin: publicBaseUrl(context.get(cloudflareContext).env, request),
        },
      );
    }

    /* Two cookies, so two Set-Cookie headers rather than one object.
       The submit cookie is rewritten without the submission id, and the
       portal cookie signs the submitter in on the way out: the success
       step hands them straight to /portal, and landing on a sign-in
       form after just proving who you are by filling in a whole
       proposal is the kind of thing that loses people. The session is
       the same one the magic link mints, so nothing new is trusted
       here that the confirmation email did not already grant. */
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      await writeSession({ participantId: session.participantId }),
    );
    if (session.participantId) {
      headers.append(
        "Set-Cookie",
        await writePortal({ participantId: session.participantId }),
      );
    }

    return redirect(`/submit/${slug}?step=done`, { headers });
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */

const input =
  "mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] outline-none placeholder:text-faint focus:border-accent-solid focus:ring-4 focus:ring-accent-ring";

const PORTAL_URL = "/portal";
const HANDOFF_SECONDS = 10;

/* ------------------------------------------------------------------ *
 * The handoff into the portal.
 *
 * The submitter is already signed in by the time they see this: the
 * review action set the portal cookie alongside the submit one, so this
 * is a plain navigation and not a login.
 *
 * Ten seconds, counted down where the reader can see it, with a link
 * that goes immediately. A redirect with no warning reads as a bug to
 * the person it happens to, and one with a countdown they cannot skip
 * is worse. The link is also the whole of the no-JavaScript story: the
 * timer never fires, the link still works, and the sentence above it
 * still says where they are going.
 * ------------------------------------------------------------------ */
function PortalHandoff() {
  const [left, setLeft] = useState(HANDOFF_SECONDS);

  useEffect(() => {
    if (left <= 0) {
      window.location.assign(PORTAL_URL);
      return;
    }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  return (
    <div className="mt-5 border-t border-line-soft pt-4">
      <p className="text-[13px] text-body">
        Taking you to your speaker portal in{" "}
        <span className="font-semibold tabular-nums text-strong">{left}</span>{" "}
        {left === 1 ? "second" : "seconds"}.
      </p>
      <p className="mt-0.5 text-[12px] text-dim">
        That is where you upload your headshot and slides, and where you can
        edit this submission while the form is open.
      </p>
      <a
        href={PORTAL_URL}
        className="mt-3 inline-block rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover"
      >
        Go now
      </a>
    </div>
  );
}

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
    roster,
    roles,
    participantCap,
    addable,
    ms,
  } = useLoaderData<typeof loader>();
  const action = useActionData<{
    error?: string;
    addError?: string;
    savedSelf?: boolean;
    participantIssues?: ParticipantIssue[];
  }>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  // Live values drive the conditional rules as the submitter types.
  const [values, setValues] = useState<ProposalValues>(() =>
    initialProposalValues(draft),
  );

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

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

        {form.autoRedirectToPortal ? (
          <PortalHandoff />
        ) : (
          <a
            href={PORTAL_URL}
            className="mt-5 inline-block rounded-lg bg-invert px-4 py-2 text-[14px] font-medium text-invert-fg hover:bg-invert-hover"
          >
            Continue to your speaker portal
          </a>
        )}
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

        <ProposalFields
          fields={proposalFields}
          trackList={trackList}
          values={values}
          onChange={set}
        />

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
    const others = roster.filter((r) => !r.isPrimary);

    return shell(
      <div className="space-y-5">
        <div>
          <h2 className="text-[16px] font-semibold">Who is presenting</h2>
          <p className="mt-0.5 text-[13px] text-dim">
            {describeRoles(roles, participantCap)}
          </p>
        </div>

        {/* Minimums and maximums, stated before they are enforced. */}
        {action?.participantIssues && action.participantIssues.length > 0 && (
          <div className="cb-note cb-note-danger px-3 py-2.5">
            <div className="text-[13px] font-medium">
              Not quite ready to continue
            </div>
            <ul className="mt-1 space-y-0.5">
              {action.participantIssues.map((p, i) => (
                <li key={i} className="text-[13px]">
                  {p.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The submitter */}
        <Form method="post" className="space-y-4 rounded-xl border border-line p-4">
          <input type="hidden" name="step" value="speaker" />
          <input type="hidden" name="pIntent" value="save_self" />
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-strong">You</span>
            <span className="cb-pill cb-pill-accent">Primary Speaker</span>
          </div>
          {speakerFields.map((f) => (
            <label key={f.id} className="block">
              <span className="text-[13px] font-medium">
                {f.label}
                {f.required && <span className="text-danger"> *</span>}
              </span>
              {f.helpText && (
                <span className="block text-[12px] text-dim">{f.helpText}</span>
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
          <button
            disabled={busy}
            className="cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]"
          >
            {busy ? "Saving" : action?.savedSelf ? "Saved" : "Save my details"}
          </button>
        </Form>

        {/* Co participants already added */}
        {others.length > 0 && (
          <ul className="space-y-2">
            {others.map((p) => (
              <li
                key={p.linkId}
                className="flex items-start gap-3 rounded-xl border border-line px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-strong">
                      {[p.firstName, p.lastName].filter(Boolean).join(" ") ||
                        p.email}
                    </span>
                    <span className="cb-pill cb-pill-neutral">{p.role}</span>
                  </div>
                  <div className="text-[12px] text-dim">
                    {[p.email, p.jobTitle, p.company].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Form method="post">
                  <input type="hidden" name="step" value="speaker" />
                  <input type="hidden" name="pIntent" value="remove" />
                  <input type="hidden" name="linkId" value={p.linkId} />
                  <button
                    disabled={busy}
                    className="cb-btn cb-btn-danger px-2 py-1 text-[12px]"
                  >
                    Remove
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        )}

        {/* Add another */}
        {addable.length > 0 ? (
          <Form
            method="post"
            className="space-y-3 rounded-xl border border-dashed border-line-strong p-4"
          >
            <input type="hidden" name="step" value="speaker" />
            <input type="hidden" name="pIntent" value="add" />
            <div className="text-[14px] font-medium text-strong">
              Add someone else
            </div>

            {action?.addError && (
              <p className="cb-note cb-note-danger px-3 py-2 text-[13px]">
                {action.addError}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[13px] font-medium">
                  First name<span className="text-danger"> *</span>
                </span>
                <input name="first_name" className={input} />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Last name</span>
                <input name="last_name" className={input} />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">
                  Email<span className="text-danger"> *</span>
                </span>
                <input name="email" type="email" className={input} />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Role</span>
                <select name="role" className={input} defaultValue={addable[0]}>
                  {addable.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Company</span>
                <input name="company" className={input} />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Job title</span>
                <input name="job_title" className={input} />
              </label>
            </div>
            <label className="block">
              <span className="text-[13px] font-medium">Biography</span>
              <textarea name="bio" rows={3} className={input} />
            </label>
            <button
              disabled={busy}
              className="cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]"
            >
              {busy ? "Adding" : "Add to submission"}
            </button>
          </Form>
        ) : (
          <p className="rounded-xl border border-dashed border-line px-4 py-3 text-[13px] text-dim">
            You have added everyone this form allows.
          </p>
        )}

        <Form method="post" className="flex gap-2">
          <input type="hidden" name="step" value="speaker" />
          <input type="hidden" name="pIntent" value="continue" />
          <a
            href="?step=proposal"
            className="cb-btn cb-btn-secondary px-4 py-2 text-[14px]"
          >
            Back
          </a>
          <button
            disabled={busy}
            className="cb-btn cb-btn-primary px-4 py-2 text-[14px]"
          >
            {busy ? "Checking" : "Continue"}
          </button>
        </Form>
      </div>,
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
