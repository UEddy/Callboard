/* ------------------------------------------------------------------ *
 * The proposal step's fields.
 *
 * Rendered in two places: the public form, where the submitter fills
 * them in, and the speaker portal, where they edit them afterwards.
 * Conditional logic is evaluated live in the browser as the values
 * change, which means both screens have to run the same evaluator or a
 * question that appears on one hides on the other.
 * ------------------------------------------------------------------ */

export type ProposalField = {
  id: string;
  required: boolean;
  conditionalRule: Record<string, unknown> | null;
  key: string;
  label: string;
  type: string;
  options: string[] | null;
  helpText: string | null;
};

export type TrackOption = { id: string; name: string };

export type ProposalValues = Record<string, string>;

const input =
  "mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] outline-none placeholder:text-faint focus:border-accent-solid focus:ring-4 focus:ring-accent-ring";

/* The track lives in its own column rather than in `answers`, so its
   field key is remapped onto the control name the action reads. */
export function controlName(field: { key: string }) {
  return field.key === "track" ? "track" : field.key;
}

export function initialProposalValues(
  draft: {
    title?: string | null;
    description?: string | null;
    format?: string | null;
    level?: string | null;
    trackId?: string | null;
    answers?: unknown;
  } | null,
): ProposalValues {
  const answers = (draft?.answers ?? {}) as Record<string, string>;
  return {
    title: draft?.title ?? "",
    description: draft?.description ?? "",
    format: draft?.format ?? "",
    level: draft?.level ?? "",
    track: draft?.trackId ?? "",
    ...answers,
  };
}

export function isVisible(field: ProposalField, values: ProposalValues) {
  const rule = field.conditionalRule as
    | { showIf?: { fieldKey: string; value: string } }
    | null;
  if (!rule?.showIf) return true;
  return values[rule.showIf.fieldKey] === rule.showIf.value;
}

export function ProposalFields({
  fields,
  trackList,
  values,
  onChange,
}: {
  fields: ProposalField[];
  trackList: TrackOption[];
  values: ProposalValues;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      {fields.map((f) => {
        if (!isVisible(f, values)) return null;
        const name = controlName(f);
        const common = {
          name,
          required: f.required,
          value: values[name] ?? "",
          onChange: (
            e: React.ChangeEvent<
              HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
            >,
          ) => onChange(name, e.target.value),
          className: input,
        };

        return (
          <label key={f.id} className="block">
            <span className="text-[13px] font-medium">
              {f.label}
              {f.required && <span className="text-danger"> *</span>}
            </span>
            {f.helpText && (
              <span className="block text-[12px] text-dim">{f.helpText}</span>
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
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : ["textarea", "wysiwyg"].includes(f.type) ? (
              <textarea {...common} rows={f.type === "wysiwyg" ? 6 : 3} />
            ) : (
              <input {...common} type={f.type === "number" ? "number" : "text"} />
            )}
          </label>
        );
      })}
    </>
  );
}
