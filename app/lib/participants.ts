/* ------------------------------------------------------------------ *
 * Who may be on a submission, and how many.
 *
 * The rules live here rather than in the form, because three places need
 * to agree about them: the public form enforcing them, the publish
 * preflight warning about them, and the builder describing them back to
 * the producer. Three copies would drift.
 * ------------------------------------------------------------------ */

export type RoleRule = { role: string; min: number; max: number | null };

/* The shape a form has when nobody has configured anything: the
   submitter, alone, as a Speaker. This is the behaviour every existing
   form had before roles were configurable, so it has to stay the
   default. */
export const DEFAULT_ROLES: RoleRule[] = [{ role: "Speaker", min: 1, max: 1 }];

export function parseRoles(raw: unknown): RoleRule[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_ROLES;
  const out: RoleRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const role = String((r as RoleRule).role ?? "").trim();
    if (!role) continue;
    const rawMin = Number((r as RoleRule).min);
    const rawMax = (r as RoleRule).max;
    const min = Number.isFinite(rawMin) ? Math.max(0, Math.trunc(rawMin)) : 0;
    const max =
      rawMax === null || rawMax === undefined || rawMax === ("" as unknown)
        ? null
        : Math.max(min, Math.trunc(Number(rawMax)));
    out.push({ role, min, max: Number.isFinite(max as number) ? max : null });
  }
  return out.length ? out : DEFAULT_ROLES;
}

export function rolesInUse(rules: RoleRule[]) {
  return rules.map((r) => r.role);
}

/* Roles a submitter may still add, given what is already on the
   submission. Used to build the dropdown so the form cannot offer a
   choice that would immediately fail validation. */
export function addableRoles(
  rules: RoleRule[],
  counts: Record<string, number>,
  cap: number | null,
  total: number,
): string[] {
  if (cap !== null && total >= cap) return [];
  return rules
    .filter((r) => r.max === null || (counts[r.role] ?? 0) < r.max)
    .map((r) => r.role);
}

export type ParticipantIssue = { role?: string; message: string };

/* Inline, specific, and phrased for the person filling the form in.
   "Add one more Moderator" beats "validation failed on field roles". */
export function validateParticipants(
  rules: RoleRule[],
  cap: number | null,
  counts: Record<string, number>,
): ParticipantIssue[] {
  const issues: ParticipantIssue[] = [];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  for (const r of rules) {
    const have = counts[r.role] ?? 0;
    if (have < r.min) {
      const missing = r.min - have;
      issues.push({
        role: r.role,
        message:
          have === 0
            ? `This form needs ${r.min} ${plural(r.role, r.min)}. Add ${missing === 1 ? "one" : missing}.`
            : `You have ${have} ${plural(r.role, have)} and this form needs ${r.min}. Add ${missing === 1 ? "one more" : `${missing} more`}.`,
      });
    }
    if (r.max !== null && have > r.max) {
      issues.push({
        role: r.role,
        message: `This form allows at most ${r.max} ${plural(r.role, r.max)}. Remove ${have - r.max}.`,
      });
    }
  }

  if (cap !== null && total > cap) {
    issues.push({
      message: `This form allows at most ${cap} ${cap === 1 ? "person" : "people"} in total. Remove ${total - cap}.`,
    });
  }

  return issues;
}

export function plural(role: string, n: number) {
  if (n === 1) return role.toLowerCase();
  return `${role.toLowerCase()}s`;
}

/* Summary line for the builder, so a producer reads the effect of the
   numbers rather than the numbers. */
export function describeRoles(rules: RoleRule[], cap: number | null): string {
  const parts = rules.map((r) => {
    const name = r.role.toLowerCase();
    if (r.min === 0 && r.max === null) return `any number of ${name}s`;
    if (r.min === 0 && r.max !== null)
      return `up to ${r.max} ${r.max === 1 ? name : `${name}s`}`;
    if (r.max === null) return `at least ${r.min} ${plural(r.role, r.min)}`;
    if (r.min === r.max) return `exactly ${r.min} ${plural(r.role, r.min)}`;
    return `${r.min} to ${r.max} ${plural(r.role, r.max)}`;
  });
  const base =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return cap === null
    ? `Submitters can add ${base}.`
    : `Submitters can add ${base}, up to ${cap} ${cap === 1 ? "person" : "people"} in total.`;
}
