/* ------------------------------------------------------------------ *
 * Chasing people.
 *
 * Two screens do it, onboarding for speakers and evaluation for
 * reviewers, and they have to agree about what a chase means: how
 * recently is too recently, and how "2d ago" is worded. One copy, so a
 * producer learns the rule once.
 * ------------------------------------------------------------------ */

export const NUDGE_COOLDOWN_HOURS = 24;

/* "today", "yesterday", "4d ago". Words rather than a timestamp,
   because the only question is whether it was recent enough to leave
   them alone. */
export function agoLabel(ms: number | null) {
  if (!ms) return null;
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function recentlyNudged(ms: number | null) {
  return ms !== null && Date.now() - ms < NUDGE_COOLDOWN_HOURS * 3_600_000;
}

export const COOLDOWN_WARNING =
  "Reminded within the last day, give them a moment";

/* The result of a round of chasing, in one sentence. Counts what left
   the building separately from what was only written down, because a
   producer who thinks forty reminders went out when the provider
   refused them all is worse off than one who was told. */
export function describeNudge(counts: {
  sent: number;
  queued: number;
  failed: number;
  skipped: number;
  firstError?: string | null;
}) {
  const bits: string[] = [];
  if (counts.sent)
    bits.push(`${counts.sent} reminder${counts.sent === 1 ? "" : "s"} sent`);
  if (counts.queued)
    bits.push(
      `${counts.queued} logged but not delivered, because no mail provider is configured`,
    );
  if (counts.failed) bits.push(`${counts.failed} failed`);
  if (counts.skipped)
    bits.push(`${counts.skipped} skipped with nothing outstanding`);

  const head = bits.length ? `${bits.join(", ")}.` : "Nobody needed chasing.";
  return counts.firstError
    ? `${head} First error: ${counts.firstError.slice(0, 200)}`
    : head;
}
