/* ------------------------------------------------------------------ *
 * Airtable client.
 *
 * D1 is the source of truth. Airtable is a mirror that a producer can
 * edit in, because that is where non-technical teams already live.
 *
 * Everything in here returns a result object rather than throwing. A bad
 * API key is an ordinary thing that happens on a Tuesday, not an
 * exception, and it should render as a sentence the producer can act on
 * rather than an error boundary.
 * ------------------------------------------------------------------ */

const API = "https://api.airtable.com/v0";

/* Airtable allows 5 requests per second per base. Everything here is
   sequential with a gap, which is slow and predictable. */
const REQUEST_GAP_MS = 220;
const BATCH_SIZE = 10; // Airtable's hard limit per create/update call
const MAX_PAGES = 20; // 100 records a page, so 2000 records a run

export type AirtableConfig = {
  apiKey: string | null;
  baseId: string | null;
  tableName: string | null;
};

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; message: string; detail?: string; status?: number };
export type Result<T> = Ok<T> | Err;

export type AirtableRecord = {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --- Config validation --------------------------------------------- */

/* Checked before any network call so the common mistakes come back
   instantly and name the field that is wrong. */
export function validateConfig(cfg: AirtableConfig): Err | null {
  if (!cfg.apiKey?.trim()) {
    return {
      ok: false,
      message: "No Airtable API key saved yet.",
      detail:
        "Add a personal access token on this page. Airtable tokens start with 'pat'.",
    };
  }
  if (!cfg.baseId?.trim()) {
    return { ok: false, message: "No Airtable base ID saved yet." };
  }
  if (!cfg.tableName?.trim()) {
    return { ok: false, message: "No Airtable table name saved yet." };
  }
  if (!/^pat[A-Za-z0-9._-]+$/.test(cfg.apiKey.trim())) {
    return {
      ok: false,
      message: "That does not look like an Airtable personal access token.",
      detail:
        "Tokens start with 'pat'. The older 'key...' API keys were retired by Airtable in 2024 and will be rejected.",
    };
  }
  if (!/^app[A-Za-z0-9]+$/.test(cfg.baseId.trim())) {
    return {
      ok: false,
      message: "That does not look like an Airtable base ID.",
      detail:
        "Base IDs start with 'app' and appear in the Airtable URL: airtable.com/appXXXXXXXX/...",
    };
  }
  return null;
}

/* --- Error translation ---------------------------------------------- */

function explain(status: number, body: string): Err {
  const detail = body.slice(0, 500);
  switch (status) {
    case 401:
      return {
        ok: false,
        status,
        message: "Airtable rejected that API key.",
        detail:
          "The token is wrong, or it has been revoked. Create a new personal access token in Airtable and paste it here.",
      };
    case 403:
      return {
        ok: false,
        status,
        message: "That token cannot reach this base.",
        detail:
          "In Airtable, give the token the data.records:read and data.records:write scopes, and add this base to the token's access list.",
      };
    case 404:
      return {
        ok: false,
        status,
        message: "Airtable could not find that base or table.",
        detail:
          "Check the base ID, and check the table name matches exactly, including capital letters and spaces.",
        // detail intentionally does not include the raw body: it is noisy
      };
    case 422:
      return {
        ok: false,
        status,
        message: "Airtable rejected the data Callboard sent.",
        detail: `Usually this means a column in your table is named differently, or is a type that will not accept the value. Airtable said: ${detail}`,
      };
    case 429:
      return {
        ok: false,
        status,
        message: "Airtable is rate limiting this base.",
        detail: "Wait about thirty seconds and run the sync again.",
      };
    default:
      if (status >= 500) {
        return {
          ok: false,
          status,
          message: `Airtable is having problems (HTTP ${status}).`,
          detail: "Nothing is wrong on this side. Try again shortly.",
        };
      }
      return {
        ok: false,
        status,
        message: `Airtable returned an unexpected response (HTTP ${status}).`,
        detail,
      };
  }
}

/* --- Transport ------------------------------------------------------- */

async function request<T>(
  cfg: AirtableConfig,
  path: string,
  init: RequestInit = {},
): Promise<Result<T>> {
  const url = `${API}/${cfg.baseId}/${encodeURIComponent(cfg.tableName!)}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    return {
      ok: false,
      message: "Could not reach Airtable.",
      detail: `The request never completed: ${String(e)}`,
    };
  }

  const text = await res.text();
  if (!res.ok) return explain(res.status, text);

  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      message: "Airtable returned something that was not JSON.",
      detail: text.slice(0, 300),
    };
  }
}

/* --- Reads ------------------------------------------------------------ */

export async function listAll(
  cfg: AirtableConfig,
): Promise<Result<AirtableRecord[]>> {
  const out: AirtableRecord[] = [];
  let offset: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ pageSize: "100" });
    if (offset) qs.set("offset", offset);

    const res = await request<{ records: AirtableRecord[]; offset?: string }>(
      cfg,
      `?${qs}`,
    );
    if (!res.ok) return res;

    out.push(...res.data.records);
    offset = res.data.offset;
    if (!offset) break;
    await sleep(REQUEST_GAP_MS);
  }

  return { ok: true, data: out };
}

/* A cheap round trip that proves the key, base, and table all work,
   without writing anything. */
export async function testConnection(
  cfg: AirtableConfig,
): Promise<Result<{ records: number; fields: string[] }>> {
  const invalid = validateConfig(cfg);
  if (invalid) return invalid;

  const res = await request<{ records: AirtableRecord[] }>(
    cfg,
    "?maxRecords=3",
  );
  if (!res.ok) return res;

  const fields = new Set<string>();
  for (const r of res.data.records) {
    for (const k of Object.keys(r.fields)) fields.add(k);
  }
  return {
    ok: true,
    data: { records: res.data.records.length, fields: [...fields] },
  };
}

/* --- Writes ----------------------------------------------------------- */

export type WriteRow = { id?: string; fields: Record<string, unknown> };

/* typecast lets Airtable coerce a string into a single select option and
   create the option if it does not exist, which is what stops a new
   track name from failing the whole batch. */
export async function createRecords(
  cfg: AirtableConfig,
  rows: WriteRow[],
): Promise<Result<AirtableRecord[]>> {
  const created: AirtableRecord[] = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const res = await request<{ records: AirtableRecord[] }>(cfg, "", {
      method: "POST",
      body: JSON.stringify({
        records: chunk.map((r) => ({ fields: r.fields })),
        typecast: true,
      }),
    });
    if (!res.ok) return res;
    created.push(...res.data.records);
    if (i + BATCH_SIZE < rows.length) await sleep(REQUEST_GAP_MS);
  }

  return { ok: true, data: created };
}

export async function updateRecords(
  cfg: AirtableConfig,
  rows: Required<WriteRow>[],
): Promise<Result<AirtableRecord[]>> {
  const updated: AirtableRecord[] = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const res = await request<{ records: AirtableRecord[] }>(cfg, "", {
      method: "PATCH",
      body: JSON.stringify({
        records: chunk.map((r) => ({ id: r.id, fields: r.fields })),
        typecast: true,
      }),
    });
    if (!res.ok) return res;
    updated.push(...res.data.records);
    if (i + BATCH_SIZE < rows.length) await sleep(REQUEST_GAP_MS);
  }

  return { ok: true, data: updated };
}

/* --- Field helpers ---------------------------------------------------- */

export const FIELD = {
  ref: "Ref",
  title: "Title",
  description: "Description",
  status: "Status",
  format: "Format",
  level: "Level",
  track: "Track",
  room: "Room",
  startsAt: "Starts At",
  speakers: "Speakers",
  callboardId: "Callboard ID",
} as const;

export const SPEAKER_FIELD = {
  name: "Name",
  email: "Email",
  company: "Company",
  jobTitle: "Job Title",
  bio: "Bio",
  callboardId: "Callboard ID",
} as const;

/* Airtable exposes a modified time only if the table has a "Last Modified
   Time" field. When it is there we can be precise about who edited last;
   when it is not we fall back to the push high water mark. */
export const LAST_MODIFIED_FIELD = "Last Modified";

export function readModifiedAt(rec: AirtableRecord): number | null {
  const raw = rec.fields[LAST_MODIFIED_FIELD];
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Single selects can come back as {name}, collaborators as arrays.
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).join(", ") || null;
  if (typeof v === "object" && "name" in (v as Record<string, unknown>)) {
    return str((v as Record<string, unknown>).name);
  }
  return null;
}

/* Descriptions are stored as HTML locally and edited as plain text in
   Airtable. Strip on the way out so the producer sees prose. */
export function toPlain(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}
