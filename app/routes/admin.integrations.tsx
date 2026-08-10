import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  integrations,
  submissions,
  submissionParticipants,
  participants,
  tracks,
  rooms,
} from "~/db/schema";
import {
  FIELD,
  SPEAKER_FIELD,
  createRecords,
  listAll,
  readModifiedAt,
  str,
  testConnection,
  toPlain,
  updateRecords,
  validateConfig,
  type AirtableConfig,
  type AirtableRecord,
  type Err,
  type WriteRow,
} from "~/lib/airtable";

/* ------------------------------------------------------------------ *
 * Optional two-way Airtable sync.
 *
 * D1 is the primary datastore and stays authoritative. Airtable is a
 * mirror that producers can edit in. Nothing on this page is required
 * for the rest of Callboard to work, and turning it off changes nothing
 * about the data.
 *
 * Conflict rule, applied per field on pull:
 *   - Airtable changed, local did not  ->  take the Airtable value
 *   - both changed                     ->  keep the local value, report it
 * "Local changed" means submissions.updated_at is newer than the last
 * push. That is what makes this last write wins rather than a blind
 * overwrite in whichever direction ran most recently.
 * ------------------------------------------------------------------ */

const PROVIDER = "airtable";

/* Only these come back from Airtable. Scheduling, decisions, and
   evaluation stay under Callboard's control on purpose: they have
   downstream effects (calendar invites, task creation) that a
   spreadsheet edit should not be able to trigger. */
const PULLABLE = ["title", "description", "format", "level", "status", "track"] as const;

const ALLOWED_STATUS = [
  "draft",
  "submitted",
  "pending",
  "accept_queue",
  "accepted",
  "decline_queue",
  "declined",
  "withdrawn",
];

type Change = {
  ref: string;
  field: string;
  from: string;
  to: string;
};

type Conflict = {
  ref: string;
  field: string;
  kept: string;
  discarded: string;
};

export type SyncReport = {
  kind: "push" | "pull" | "test" | "save";
  ok: boolean;
  message: string;
  detail?: string;
  created?: number;
  updated?: number;
  changes?: Change[];
  conflicts?: Conflict[];
  skipped?: number;
};

/* --- Loader --------------------------------------------------------- */

export async function loader({ context }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);

  const row = await db.query.integrations.findFirst({
    where: and(
      eq(integrations.eventId, DEMO_EVENT_ID),
      eq(integrations.provider, PROVIDER),
    ),
  });

  const accepted = await db
    .select({
      id: submissions.id,
      airtableRecordId: submissions.airtableRecordId,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.eventId, DEMO_EVENT_ID),
        eq(submissions.status, "accepted"),
      ),
    );

  // Never send the saved key to the browser. The last four characters are
  // enough for a human to confirm which token is in use.
  const keyHint = row?.apiKey
    ? `${row.apiKey.slice(0, 3)}...${row.apiKey.slice(-4)}`
    : null;

  return {
    settings: {
      baseId: row?.baseId ?? "",
      tableName: row?.tableName ?? "",
      speakersTableName: row?.speakersTableName ?? "",
      enabled: row?.enabled ?? false,
      lastPushAt: row?.lastPushAt ? new Date(row.lastPushAt).getTime() : null,
      lastPullAt: row?.lastPullAt ? new Date(row.lastPullAt).getTime() : null,
      lastError: row?.lastError ?? null,
    },
    keyHint,
    hasKey: Boolean(row?.apiKey),
    counts: {
      accepted: accepted.length,
      mirrored: accepted.filter((a) => a.airtableRecordId).length,
    },
    ms: Date.now() - started,
  };
}

/* --- Helpers -------------------------------------------------------- */

async function loadConfig(db: ReturnType<typeof getDb>) {
  const row = await db.query.integrations.findFirst({
    where: and(
      eq(integrations.eventId, DEMO_EVENT_ID),
      eq(integrations.provider, PROVIDER),
    ),
  });
  if (!row) return null;
  return row;
}

function asConfig(row: {
  apiKey: string | null;
  baseId: string | null;
  tableName: string | null;
}): AirtableConfig {
  return { apiKey: row.apiKey, baseId: row.baseId, tableName: row.tableName };
}

function errReport(kind: SyncReport["kind"], e: Err): SyncReport {
  return { kind, ok: false, message: e.message, detail: e.detail };
}

async function recordError(
  db: ReturnType<typeof getDb>,
  message: string | null,
) {
  await db
    .update(integrations)
    .set({ lastError: message, updatedAt: new Date() })
    .where(
      and(
        eq(integrations.eventId, DEMO_EVENT_ID),
        eq(integrations.provider, PROVIDER),
      ),
    );
}

/* Rows for the submissions mirror, with speakers denormalised so the
   table is readable on its own. */
async function buildSubmissionRows(db: ReturnType<typeof getDb>) {
  const rows = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      description: submissions.description,
      status: submissions.status,
      format: submissions.format,
      level: submissions.level,
      startsAt: submissions.startsAt,
      updatedAt: submissions.updatedAt,
      airtableRecordId: submissions.airtableRecordId,
      trackName: tracks.name,
      roomName: rooms.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(
      and(
        eq(submissions.eventId, DEMO_EVENT_ID),
        eq(submissions.status, "accepted"),
      ),
    );

  const ids = rows.map((r) => r.id);
  const people = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          id: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
          email: participants.email,
          company: participants.company,
          jobTitle: participants.jobTitle,
          bio: participants.bio,
          airtableRecordId: participants.airtableRecordId,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
    : [];

  return { rows, people };
}

/* --- Action --------------------------------------------------------- */

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));
  const now = new Date();

  /* --- Save settings ------------------------------------------------ */
  if (intent === "save") {
    const existing = await loadConfig(db);
    const submitted = String(fd.get("apiKey") ?? "").trim();
    // An empty key field means "leave the saved one alone", so the page
    // can be re-saved without re-pasting the token every time.
    const apiKey = submitted || existing?.apiKey || null;

    const values = {
      apiKey,
      baseId: String(fd.get("baseId") ?? "").trim() || null,
      tableName: String(fd.get("tableName") ?? "").trim() || null,
      speakersTableName:
        String(fd.get("speakersTableName") ?? "").trim() || null,
      enabled: fd.get("enabled") === "on",
      updatedAt: now,
    };

    if (existing) {
      await db
        .update(integrations)
        .set(values)
        .where(eq(integrations.id, existing.id));
    } else {
      await db
        .insert(integrations)
        .values({ eventId: DEMO_EVENT_ID, provider: PROVIDER, ...values });
    }

    return {
      kind: "save",
      ok: true,
      message: "Settings saved.",
    } satisfies SyncReport;
  }

  if (intent === "disconnect") {
    const existing = await loadConfig(db);
    if (existing) {
      await db
        .update(integrations)
        .set({
          apiKey: null,
          enabled: false,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(integrations.id, existing.id));
    }
    return {
      kind: "save",
      ok: true,
      message: "Airtable key removed. Nothing else was changed.",
    } satisfies SyncReport;
  }

  /* Everything below needs a working configuration. */
  const row = await loadConfig(db);
  if (!row) {
    return {
      kind: intent === "pull" ? "pull" : intent === "push" ? "push" : "test",
      ok: false,
      message: "Airtable is not set up yet.",
      detail: "Fill in the key, base ID, and table name above, then save.",
    } satisfies SyncReport;
  }

  const cfg = asConfig(row);
  const invalid = validateConfig(cfg);
  if (invalid) {
    await recordError(db, invalid.message);
    return errReport(
      intent === "pull" ? "pull" : intent === "push" ? "push" : "test",
      invalid,
    );
  }

  /* --- Test connection ---------------------------------------------- */
  if (intent === "test") {
    const res = await testConnection(cfg);
    if (!res.ok) {
      await recordError(db, res.message);
      return errReport("test", res);
    }
    await recordError(db, null);

    const expected = Object.values(FIELD) as string[];
    const missing = res.data.fields.length
      ? expected.filter((f) => !res.data.fields.includes(f))
      : [];

    return {
      kind: "test",
      ok: true,
      message: `Connected. Read ${res.data.records} record${res.data.records === 1 ? "" : "s"} from "${row.tableName}".`,
      detail: missing.length
        ? `These columns are not in the table yet and will be created on first push, or will need adding by hand if Airtable refuses them: ${missing.join(", ")}.`
        : res.data.records === 0
          ? "The table is empty, so the columns could not be checked. A push will populate it."
          : undefined,
    } satisfies SyncReport;
  }

  /* --- Push --------------------------------------------------------- */
  if (intent === "push") {
    const { rows, people } = await buildSubmissionRows(db);
    if (rows.length === 0) {
      return {
        kind: "push",
        ok: true,
        message: "Nothing to push. No submissions are accepted yet.",
      } satisfies SyncReport;
    }

    // Existing records are read once so that a first push into a table
    // that already has rows matches on Callboard ID instead of creating
    // a duplicate set.
    const existing = await listAll(cfg);
    if (!existing.ok) {
      await recordError(db, existing.message);
      return errReport("push", existing);
    }
    const byCallboardId = new Map<string, string>();
    for (const rec of existing.data) {
      const cid = str(rec.fields[FIELD.callboardId]);
      if (cid) byCallboardId.set(cid, rec.id);
    }
    const liveIds = new Set(existing.data.map((r) => r.id));

    const toCreate: { local: string; row: WriteRow }[] = [];
    const toUpdate: { local: string; row: Required<WriteRow> }[] = [];

    for (const r of rows) {
      const speakers = people.filter((p) => p.submissionId === r.id);
      const fields: Record<string, unknown> = {
        [FIELD.ref]: r.ref,
        [FIELD.title]: r.title,
        [FIELD.description]: toPlain(r.description),
        [FIELD.status]: r.status,
        [FIELD.format]: r.format ?? "",
        [FIELD.level]: r.level ?? "",
        [FIELD.track]: r.trackName ?? "",
        [FIELD.room]: r.roomName ?? "",
        [FIELD.startsAt]: r.startsAt
          ? new Date(r.startsAt).toISOString()
          : null,
        [FIELD.speakers]: speakers
          .map((s) => [s.firstName, s.lastName].filter(Boolean).join(" "))
          .join(", "),
        [FIELD.callboardId]: r.id,
      };

      // A stored record id that Airtable no longer has (someone deleted
      // the row) would 404 the whole batch, so fall back to creating.
      const known =
        (r.airtableRecordId && liveIds.has(r.airtableRecordId)
          ? r.airtableRecordId
          : null) ?? byCallboardId.get(r.id) ?? null;

      if (known) toUpdate.push({ local: r.id, row: { id: known, fields } });
      else toCreate.push({ local: r.id, row: { fields } });
    }

    if (toUpdate.length) {
      const res = await updateRecords(
        cfg,
        toUpdate.map((t) => t.row),
      );
      if (!res.ok) {
        await recordError(db, res.message);
        return errReport("push", res);
      }
    }

    if (toCreate.length) {
      const res = await createRecords(
        cfg,
        toCreate.map((t) => t.row),
      );
      if (!res.ok) {
        await recordError(db, res.message);
        return errReport("push", res);
      }
      // Airtable returns created records in the order they were sent.
      for (let i = 0; i < res.data.length; i++) {
        const local = toCreate[i]?.local;
        if (!local) continue;
        await db
          .update(submissions)
          .set({ airtableRecordId: res.data[i].id, airtableSyncedAt: now })
          .where(eq(submissions.id, local));
      }
    }

    for (const t of toUpdate) {
      await db
        .update(submissions)
        .set({ airtableRecordId: t.row.id, airtableSyncedAt: now })
        .where(eq(submissions.id, t.local));
    }

    /* Speakers get their own table only if one is configured. */
    let speakerNote = "";
    if (row.speakersTableName) {
      const speakerCfg: AirtableConfig = {
        ...cfg,
        tableName: row.speakersTableName,
      };
      const unique = new Map<string, (typeof people)[number]>();
      for (const p of people) if (!unique.has(p.id)) unique.set(p.id, p);

      const existingSpeakers = await listAll(speakerCfg);
      if (!existingSpeakers.ok) {
        await recordError(db, existingSpeakers.message);
        return errReport("push", existingSpeakers);
      }
      const speakerByCid = new Map<string, string>();
      for (const rec of existingSpeakers.data) {
        const cid = str(rec.fields[SPEAKER_FIELD.callboardId]);
        if (cid) speakerByCid.set(cid, rec.id);
      }
      const liveSpeakerIds = new Set(existingSpeakers.data.map((r) => r.id));

      const sCreate: { local: string; row: WriteRow }[] = [];
      const sUpdate: { local: string; row: Required<WriteRow> }[] = [];

      for (const p of unique.values()) {
        const fields: Record<string, unknown> = {
          [SPEAKER_FIELD.name]: [p.firstName, p.lastName]
            .filter(Boolean)
            .join(" "),
          [SPEAKER_FIELD.email]: p.email,
          [SPEAKER_FIELD.company]: p.company ?? "",
          [SPEAKER_FIELD.jobTitle]: p.jobTitle ?? "",
          [SPEAKER_FIELD.bio]: toPlain(p.bio),
          [SPEAKER_FIELD.callboardId]: p.id,
        };
        const known =
          (p.airtableRecordId && liveSpeakerIds.has(p.airtableRecordId)
            ? p.airtableRecordId
            : null) ?? speakerByCid.get(p.id) ?? null;
        if (known) sUpdate.push({ local: p.id, row: { id: known, fields } });
        else sCreate.push({ local: p.id, row: { fields } });
      }

      if (sUpdate.length) {
        const res = await updateRecords(
          speakerCfg,
          sUpdate.map((s) => s.row),
        );
        if (!res.ok) {
          await recordError(db, res.message);
          return errReport("push", res);
        }
        for (const s of sUpdate) {
          await db
            .update(participants)
            .set({ airtableRecordId: s.row.id, airtableSyncedAt: now })
            .where(eq(participants.id, s.local));
        }
      }
      if (sCreate.length) {
        const res = await createRecords(
          speakerCfg,
          sCreate.map((s) => s.row),
        );
        if (!res.ok) {
          await recordError(db, res.message);
          return errReport("push", res);
        }
        for (let i = 0; i < res.data.length; i++) {
          const local = sCreate[i]?.local;
          if (!local) continue;
          await db
            .update(participants)
            .set({ airtableRecordId: res.data[i].id, airtableSyncedAt: now })
            .where(eq(participants.id, local));
        }
      }
      speakerNote = ` ${unique.size} speaker${unique.size === 1 ? "" : "s"} mirrored to "${row.speakersTableName}".`;
    }

    await db
      .update(integrations)
      .set({ lastPushAt: now, lastError: null, updatedAt: now })
      .where(eq(integrations.id, row.id));

    return {
      kind: "push",
      ok: true,
      message: `Pushed ${rows.length} accepted session${rows.length === 1 ? "" : "s"} to "${row.tableName}".${speakerNote}`,
      created: toCreate.length,
      updated: toUpdate.length,
    } satisfies SyncReport;
  }

  /* --- Pull --------------------------------------------------------- */
  if (intent === "pull") {
    const fetched = await listAll(cfg);
    if (!fetched.ok) {
      await recordError(db, fetched.message);
      return errReport("pull", fetched);
    }

    const local = await db
      .select({
        id: submissions.id,
        ref: submissions.ref,
        title: submissions.title,
        description: submissions.description,
        status: submissions.status,
        format: submissions.format,
        level: submissions.level,
        trackId: submissions.trackId,
        updatedAt: submissions.updatedAt,
        airtableRecordId: submissions.airtableRecordId,
      })
      .from(submissions)
      .where(eq(submissions.eventId, DEMO_EVENT_ID));

    const trackList = await db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.eventId, DEMO_EVENT_ID));
    const trackByName = new Map(
      trackList.map((t) => [t.name.toLowerCase(), t.id]),
    );
    const trackById = new Map(trackList.map((t) => [t.id, t.name]));

    const byRecordId = new Map(
      local.filter((l) => l.airtableRecordId).map((l) => [l.airtableRecordId!, l]),
    );
    const byId = new Map(local.map((l) => [l.id, l]));

    const pushedAt = row.lastPushAt ? new Date(row.lastPushAt).getTime() : 0;

    const changes: Change[] = [];
    const conflicts: Conflict[] = [];
    let skipped = 0;
    let touched = 0;

    for (const rec of fetched.data) {
      const cid = str(rec.fields[FIELD.callboardId]);
      const match = byRecordId.get(rec.id) ?? (cid ? byId.get(cid) : undefined);
      if (!match) {
        // A row created directly in Airtable. Deliberately not imported:
        // a submission has a speaker, a form, and a ref, and inventing
        // those from a spreadsheet row does more harm than good.
        skipped++;
        continue;
      }

      const localChanged =
        match.updatedAt && new Date(match.updatedAt).getTime() > pushedAt;

      // If the table carries a Last Modified field, use it to skip rows
      // Airtable has not touched since our push.
      const remoteModified = readModifiedAt(rec);
      if (remoteModified !== null && pushedAt && remoteModified <= pushedAt) {
        continue;
      }

      const patch: Record<string, unknown> = {};

      const consider = (
        field: (typeof PULLABLE)[number],
        current: string | null,
        incoming: string | null,
        apply: (v: string) => void,
        display?: (v: string | null) => string,
      ) => {
        if (incoming === null) return;
        const show = display ?? ((v: string | null) => v ?? "(empty)");
        if ((current ?? "") === incoming) return;
        if (localChanged) {
          conflicts.push({
            ref: match.ref,
            field,
            kept: show(current),
            discarded: show(incoming),
          });
          return;
        }
        apply(incoming);
        changes.push({
          ref: match.ref,
          field,
          from: show(current),
          to: show(incoming),
        });
      };

      consider("title", match.title, str(rec.fields[FIELD.title]), (v) => {
        patch.title = v;
      });

      consider(
        "description",
        toPlain(match.description),
        str(rec.fields[FIELD.description]),
        (v) => {
          patch.description = v;
        },
        (v) => (v ? `${v.slice(0, 60)}${v.length > 60 ? "..." : ""}` : "(empty)"),
      );

      consider("format", match.format, str(rec.fields[FIELD.format]), (v) => {
        patch.format = v;
      });

      consider("level", match.level, str(rec.fields[FIELD.level]), (v) => {
        patch.level = v;
      });

      const incomingStatus = str(rec.fields[FIELD.status]);
      if (incomingStatus && !ALLOWED_STATUS.includes(incomingStatus)) {
        conflicts.push({
          ref: match.ref,
          field: "status",
          kept: match.status,
          discarded: `${incomingStatus} (not a valid status)`,
        });
      } else {
        consider("status", match.status, incomingStatus, (v) => {
          patch.status = v;
        });
      }

      const incomingTrack = str(rec.fields[FIELD.track]);
      if (incomingTrack) {
        const resolved = trackByName.get(incomingTrack.toLowerCase());
        if (!resolved) {
          conflicts.push({
            ref: match.ref,
            field: "track",
            kept: trackById.get(match.trackId ?? "") ?? "(none)",
            discarded: `${incomingTrack} (no track by that name)`,
          });
        } else {
          consider(
            "track",
            trackById.get(match.trackId ?? "") ?? null,
            incomingTrack,
            () => {
              patch.trackId = resolved;
            },
          );
        }
      }

      if (Object.keys(patch).length > 0) {
        await db
          .update(submissions)
          .set({
            ...patch,
            updatedAt: now,
            airtableRecordId: rec.id,
            airtableSyncedAt: now,
          })
          .where(eq(submissions.id, match.id));
        touched++;
      }
    }

    await db
      .update(integrations)
      .set({ lastPullAt: now, lastError: null, updatedAt: now })
      .where(eq(integrations.id, row.id));

    return {
      kind: "pull",
      ok: true,
      message:
        changes.length === 0 && conflicts.length === 0
          ? "Pull finished. Nothing in Airtable had changed."
          : `Applied ${changes.length} change${changes.length === 1 ? "" : "s"} across ${touched} session${touched === 1 ? "" : "s"}.`,
      changes,
      conflicts,
      skipped,
    } satisfies SyncReport;
  }

  return { kind: "test", ok: false, message: "Unknown action." } satisfies SyncReport;
}

/* --- UI -------------------------------------------------------------- */

const input =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-accent-solid focus:ring-2 focus:ring-accent-ring";

function ago(ms: number | null) {
  if (!ms) return "never";
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Integrations() {
  const { settings, keyHint, hasKey, counts, ms } = useLoaderData<typeof loader>();
  const report = useActionData<SyncReport>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const runningIntent = nav.formData?.get("intent");

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">
              Integrations
            </h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Optional. Callboard keeps its own copy of everything; Airtable is
              a mirror your team can edit in.
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim">
            {ms} ms
          </div>
        </div>
      </div>

      <div className="max-w-3xl px-6 py-4">
        {/* Result banner */}
        {report && (
          <div
            className={[
              "mb-4 rounded-lg border px-4 py-3",
              report.ok
                ? "border-success-ring bg-success-soft"
                : "border-danger-ring bg-danger-soft",
            ].join(" ")}
          >
            <div
              className={[
                "text-[13px] font-medium",
                report.ok ? "text-success" : "text-danger",
              ].join(" ")}
            >
              {report.message}
            </div>
            {report.detail && (
              <div
                className={[
                  "mt-1 text-[12px]",
                  report.ok ? "text-success" : "text-danger",
                ].join(" ")}
              >
                {report.detail}
              </div>
            )}

            {report.kind === "push" &&
              (report.created !== undefined || report.updated !== undefined) && (
                <div className="mt-1 text-[12px] text-success tabular-nums">
                  {report.updated ?? 0} updated, {report.created ?? 0} created.
                </div>
              )}

            {report.changes && report.changes.length > 0 && (
              <div className="mt-2">
                <div className="text-[12px] font-medium text-success">
                  Changed from Airtable
                </div>
                <ul className="mt-1 space-y-0.5">
                  {report.changes.map((c, i) => (
                    <li key={i} className="text-[12px] text-success">
                      <span className="font-mono text-[11px] text-success">
                        {c.ref}
                      </span>{" "}
                      <span className="font-medium">{c.field}</span>:{" "}
                      <span className="text-success line-through">
                        {c.from}
                      </span>{" "}
                      to <span className="font-medium">{c.to}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.conflicts && report.conflicts.length > 0 && (
              <div className="mt-2 rounded-md bg-warn-soft px-3 py-2 ring-1 ring-inset ring-warn-ring">
                <div className="text-[12px] font-medium text-warn">
                  Kept the Callboard value ({report.conflicts.length})
                </div>
                <p className="text-[11px] text-warn">
                  These changed on both sides since the last push, so the local
                  value won.
                </p>
                <ul className="mt-1 space-y-0.5">
                  {report.conflicts.map((c, i) => (
                    <li key={i} className="text-[12px] text-warn">
                      <span className="font-mono text-[11px] text-warn">
                        {c.ref}
                      </span>{" "}
                      <span className="font-medium">{c.field}</span>: kept{" "}
                      <span className="font-medium">{c.kept}</span>, ignored{" "}
                      {c.discarded}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.kind === "pull" && (report.skipped ?? 0) > 0 && (
              <p className="mt-2 text-[12px] text-success">
                {report.skipped} Airtable row
                {report.skipped === 1 ? " was" : "s were"} ignored because
                {report.skipped === 1 ? " it does" : " they do"} not match a
                Callboard submission. Rows created directly in Airtable are not
                imported.
              </p>
            )}
          </div>
        )}

        {settings.lastError && !report && (
          <div className="mb-4 rounded-lg border border-warn-ring bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <span className="font-medium">Last sync failed:</span>{" "}
            {settings.lastError}
          </div>
        )}

        {/* Settings */}
        <section className="mb-6">
          <h2 className="text-[15px] font-semibold tracking-tight">Airtable</h2>
          <p className="mb-3 mt-0.5 text-[13px] text-dim">
            Mirror accepted sessions and speakers into an Airtable base, and
            read producer edits back.
          </p>

          <Form
            method="post"
            className="space-y-4 rounded-lg border border-line bg-surface p-4"
          >
            <input type="hidden" name="intent" value="save" />

            <label className="block">
              <span className="text-[13px] font-medium">
                Personal access token
              </span>
              <span className="block text-[12px] text-dim">
                {hasKey
                  ? `A key is saved (${keyHint}). Leave this blank to keep it.`
                  : "Create one in Airtable with the data.records:read and data.records:write scopes."}
              </span>
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={hasKey ? "Unchanged" : "patXXXXXXXXXXXXXX"}
                className={`${input} font-mono`}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[13px] font-medium">Base ID</span>
                <input
                  name="baseId"
                  defaultValue={settings.baseId}
                  placeholder="appXXXXXXXXXXXXXX"
                  className={`${input} font-mono`}
                />
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Table name</span>
                <input
                  name="tableName"
                  defaultValue={settings.tableName}
                  placeholder="Sessions"
                  className={input}
                />
              </label>
            </div>

            <label className="block">
              <span className="text-[13px] font-medium">
                Speakers table name
              </span>
              <span className="block text-[12px] text-dim">
                Optional. Leave blank and speakers are mirrored as a text
                column on each session instead of getting their own rows.
              </span>
              <input
                name="speakersTableName"
                defaultValue={settings.speakersTableName}
                placeholder="Speakers"
                className={input}
              />
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={settings.enabled}
                className="h-4 w-4 rounded border-line-strong"
              />
              <span className="text-[13px]">Enable this integration</span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                disabled={busy}
                className="rounded-md bg-invert px-3 py-1.5 text-[13px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
              >
                {busy && runningIntent === "save" ? "Saving" : "Save settings"}
              </button>
              <button
                formMethod="post"
                name="intent"
                value="test"
                disabled={busy}
                className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium text-body hover:bg-subtle disabled:opacity-50"
              >
                {busy && runningIntent === "test"
                  ? "Checking"
                  : "Test connection"}
              </button>
            </div>
          </Form>
        </section>

        {/* Sync */}
        <section className="mb-6">
          <h2 className="text-[15px] font-semibold tracking-tight">Sync</h2>
          <p className="mb-3 mt-0.5 text-[13px] text-dim">
            Both directions are manual. Nothing runs on a schedule, so a sync
            only ever happens when you press a button.
          </p>

          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Accepted sessions", value: counts.accepted },
                { label: "Mirrored in Airtable", value: counts.mirrored },
                { label: "Last push", value: ago(settings.lastPushAt) },
                { label: "Last pull", value: ago(settings.lastPullAt) },
              ].map((s) => (
                <div key={s.label}>
                  <div className="text-[15px] font-semibold tabular-nums text-strong">
                    {s.value}
                  </div>
                  <div className="text-[12px] text-dim">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-line-soft pt-3">
              <Form method="post">
                <input type="hidden" name="intent" value="push" />
                <button
                  disabled={busy}
                  className="rounded-md bg-invert px-3 py-1.5 text-[13px] font-medium text-invert-fg hover:bg-invert-hover disabled:opacity-50"
                  title="Send accepted sessions and speakers to Airtable"
                >
                  {busy && runningIntent === "push"
                    ? "Pushing"
                    : "Push to Airtable"}
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="pull" />
                <button
                  disabled={busy}
                  className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium text-body hover:bg-subtle disabled:opacity-50"
                  title="Read edits back from Airtable"
                >
                  {busy && runningIntent === "pull" ? "Pulling" : "Pull changes"}
                </button>
              </Form>
              {hasKey && (
                <Form method="post" className="ml-auto">
                  <input type="hidden" name="intent" value="disconnect" />
                  <button
                    disabled={busy}
                    className="rounded-md px-3 py-1.5 text-[13px] text-dim hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                  >
                    Remove key
                  </button>
                </Form>
              )}
            </div>
          </div>
        </section>

        {/* What the table needs */}
        <section>
          <h2 className="text-[15px] font-semibold tracking-tight">
            What your Airtable table needs
          </h2>
          <p className="mb-3 mt-0.5 text-[13px] text-dim">
            Column names must match exactly. Anything missing gets created on
            first push where Airtable allows it.
          </p>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line bg-subtle text-[11px] uppercase tracking-[0.06em] text-dim">
                  <th className="px-4 py-2 font-medium">Column</th>
                  <th className="px-4 py-2 font-medium">Suggested type</th>
                  <th className="px-4 py-2 font-medium">Read back on pull</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Ref", "Single line text", "No"],
                  ["Title", "Single line text", "Yes"],
                  ["Description", "Long text", "Yes"],
                  ["Status", "Single select", "Yes"],
                  ["Format", "Single select", "Yes"],
                  ["Level", "Single select", "Yes"],
                  ["Track", "Single select", "Yes, if the name matches"],
                  ["Room", "Single line text", "No"],
                  ["Starts At", "Date with time", "No"],
                  ["Speakers", "Single line text", "No"],
                  ["Callboard ID", "Single line text", "No"],
                  ["Last Modified", "Last modified time (optional)", "Read only"],
                ].map(([col, type, pull]) => (
                  <tr key={col} className="border-b border-line-soft last:border-0">
                    <td className="px-4 py-2 font-mono text-[12px] text-body">
                      {col}
                    </td>
                    <td className="px-4 py-2 text-body">{type}</td>
                    <td className="px-4 py-2 text-dim">{pull}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[12px] text-dim">
            Scheduling, decisions, and evaluation are deliberately push only. An
            edit in a spreadsheet should not be able to move a session or send
            an acceptance email.
          </p>
        </section>
      </div>
    </div>
  );
}
