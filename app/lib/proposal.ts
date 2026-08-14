/* ------------------------------------------------------------------ *
 * The proposal, and who is allowed to change it.
 *
 * A proposal can be edited from two places: the public form while the
 * submitter is filling it in, and the speaker portal afterwards. Both
 * write the same six columns plus the same `answers` blob, and both
 * re-run routing, so this is the single implementation they call rather
 * than two that drift apart the first time a column is added.
 *
 * The editing window is here for the same reason. The public form and
 * the portal have to agree exactly on when a form is shut, or a speaker
 * is told editing has closed on a form that is still taking entries.
 * ------------------------------------------------------------------ */

import { eq } from "drizzle-orm";
import { submissions } from "~/db/schema";
import { applyRoutingRules } from "~/lib/routing";
import { fmtDateIn } from "~/lib/tz";
import type { getDb } from "~/db/client";

type Db = ReturnType<typeof getDb>;

/* --- The window ----------------------------------------------------- */

export type FormWindow = {
  status: string;
  closeAt: Date | number | string | null;
};

/* Open means both things: the producer has published it and the close
   date has not passed. A form left in draft is not open no matter what
   its close date says. */
export function formIsOpen(form: FormWindow | null | undefined): boolean {
  if (!form) return false;
  if (form.status !== "open") return false;
  if (!form.closeAt) return true;
  return new Date(form.closeAt).getTime() > Date.now();
}

/* Why it is shut, in a sentence a speaker can act on. The date is read
   in the event's zone, because "closed on September 15" has to mean the
   same day to the organiser and to the speaker reading it. */
export function closedReason(
  form: FormWindow | null | undefined,
  eventZone: string,
): string {
  if (!form) {
    return "This submission did not come from a form, so it cannot be edited here. Contact the organisers if something needs to change.";
  }
  if (form.closeAt && new Date(form.closeAt).getTime() <= Date.now()) {
    const when = fmtDateIn(new Date(form.closeAt).getTime(), eventZone, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    return `Editing closed when the form closed on ${when}. Contact the organisers if something needs to change.`;
  }
  return "This form is no longer accepting changes. Contact the organisers if something needs to change.";
}

/* --- Reading the form ------------------------------------------------ */

/* Names the proposal form uses for its own plumbing, plus the six that
   land in real columns. Everything else a form collects is a field key
   and goes into `answers`, so anything added here has to be a name no
   field definition will ever use. */
export const RESERVED_PROPOSAL_KEYS = [
  "step",
  "intent",
  "submissionId",
  "tab",
  "title",
  "description",
  "format",
  "level",
  "track",
];

export type ProposalPatch = {
  title: string;
  description: string;
  format: string | null;
  level: string | null;
  trackId: string | null;
  answers: Record<string, unknown>;
};

export function readProposal(fd: FormData): ProposalPatch {
  const answers: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (RESERVED_PROPOSAL_KEYS.includes(k)) continue;
    answers[k] = v;
  }
  return {
    title: String(fd.get("title") ?? ""),
    description: String(fd.get("description") ?? ""),
    format: String(fd.get("format") ?? "") || null,
    level: String(fd.get("level") ?? "") || null,
    trackId: String(fd.get("track") ?? "") || null,
    answers,
  };
}

/* --- Writing it back -------------------------------------------------- */

/* Routing re-runs on every save, not just the first, so a speaker who
   switches from workshop to talk does not stay in the workshop queue.
   It is a convenience for the organiser: if it fails the proposal is
   already saved and a producer can sort it out by hand. */
export async function saveProposal(
  db: Db,
  opts: {
    submissionId: string;
    eventId: string;
    formId: string | null;
    patch: ProposalPatch;
  },
) {
  const { submissionId, eventId, formId, patch } = opts;

  await db
    .update(submissions)
    .set({
      title: patch.title,
      description: patch.description,
      format: patch.format,
      level: patch.level,
      trackId: patch.trackId,
      answers: patch.answers,
      updatedAt: new Date(),
    })
    .where(eq(submissions.id, submissionId));

  if (!formId) return;

  try {
    await applyRoutingRules(db, { eventId, formId, submissionId });
  } catch (e) {
    console.error("routing failed for", submissionId, e);
  }
}
