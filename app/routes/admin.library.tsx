import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, asc, eq, ne } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  embeds,
  fieldDefinitions,
  formFields,
  forms,
  personas,
  rooms,
  routingRules,
  submissions,
  tags,
  tasks,
  tracks,
} from "~/db/schema";
import { parseRoles } from "~/lib/participants";

/* ------------------------------------------------------------------ *
 * The library: fields, tags, personas, rooms and tracks, defined once
 * per event.
 *
 * These are the vocabulary the rest of the app is built from, which is
 * why deleting is the dangerous verb here rather than editing. A field
 * still on a form, a tag still on submissions, a persona a form's
 * participant rules still name, a room with sessions in it, a track a
 * routing rule still assigns: each of those breaks something
 * elsewhere, so each one is counted and named before you can remove it.
 * ------------------------------------------------------------------ */

const TABS = ["fields", "tags", "personas", "rooms", "tracks"] as const;
type Tab = (typeof TABS)[number];

export const FIELD_TYPES = [
  "text",
  "textarea",
  "wysiwyg",
  "dropdown",
  "multiselect",
  "checkbox",
  "radio",
  "email",
  "phone",
  "url",
  "date",
  "file",
  "number",
] as const;

/* Types that are meaningless without a list to choose from. The publish
   preflight already blocks a form carrying one with no options, so the
   library warns at the point the mistake is made. */
const CHOICE_TYPES = ["dropdown", "multiselect", "radio"];

const DEFAULT_TAG_COLOURS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#f43f5e",
  "#0ea5e9",
  "#8b5cf6",
  "#ec4899",
  "#94a3b8",
];

/* The key is what forms, routing rules and stored answers reference, so
   it is derived once and never changed afterwards. */
function toKey(label: string) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field"
  );
}

async function uniqueKey(
  db: ReturnType<typeof getDb>,
  base: string,
): Promise<string> {
  const existing = await db
    .select({ key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.eventId, DEMO_EVENT_ID));
  const taken = new Set(existing.map((e) => e.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) {
    if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  }
  return `${base}_${Date.now()}`;
}

function parseOptions(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildValidation(fd: FormData): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const num = (k: string) => {
    const v = String(fd.get(k) ?? "").trim();
    if (v === "") return;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  };
  num("maxLength");
  num("min");
  num("max");
  const pattern = String(fd.get("pattern") ?? "").trim();
  if (pattern) out.pattern = pattern;
  const accept = String(fd.get("accept") ?? "").trim();
  if (accept) out.accept = accept;
  return Object.keys(out).length ? out : null;
}

/* --- Loader --------------------------------------------------------- */

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);
  const raw = url.searchParams.get("tab") ?? "fields";
  const tab: Tab = (TABS as readonly string[]).includes(raw)
    ? (raw as Tab)
    : "fields";

  const [fieldList, tagList, personaList, formList, roomList, trackList] =
    await Promise.all([
      db
        .select()
        .from(fieldDefinitions)
        .where(eq(fieldDefinitions.eventId, DEMO_EVENT_ID))
        .orderBy(asc(fieldDefinitions.label)),
      db
        .select()
        .from(tags)
        .where(eq(tags.eventId, DEMO_EVENT_ID))
        .orderBy(asc(tags.name)),
      db
        .select()
        .from(personas)
        .where(eq(personas.eventId, DEMO_EVENT_ID))
        .orderBy(asc(personas.name)),
      db
        .select({
          id: forms.id,
          name: forms.name,
          participantRoles: forms.participantRoles,
        })
        .from(forms)
        .where(eq(forms.eventId, DEMO_EVENT_ID)),
      db
        .select()
        .from(rooms)
        .where(eq(rooms.eventId, DEMO_EVENT_ID))
        .orderBy(asc(rooms.sortOrder), asc(rooms.name)),
      db
        .select()
        .from(tracks)
        .where(eq(tracks.eventId, DEMO_EVENT_ID))
        .orderBy(asc(tracks.sortOrder), asc(tracks.name)),
    ]);

  /* Which forms use which field. Named, not just counted: "in use on 2
     forms" makes a producer go hunting. */
  const usageRows = await db
    .select({
      fieldDefinitionId: formFields.fieldDefinitionId,
      formId: formFields.formId,
    })
    .from(formFields);
  const formNameById = new Map(formList.map((f) => [f.id, f.name]));
  const fieldUsage: Record<string, string[]> = {};
  for (const u of usageRows) {
    const name = formNameById.get(u.formId);
    if (!name) continue;
    const arr = (fieldUsage[u.fieldDefinitionId] ??= []);
    if (!arr.includes(name)) arr.push(name);
  }

  /* One pass over the submissions covers tags, rooms and tracks. Tag
     usage is counted in memory because tag_ids is a JSON array rather
     than something a join could reach. */
  const subRows = await db
    .select({
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      roomId: submissions.roomId,
      trackId: submissions.trackId,
      startsAt: submissions.startsAt,
      tagIds: submissions.tagIds,
    })
    .from(submissions)
    .where(eq(submissions.eventId, DEMO_EVENT_ID));

  const tagUsage: Record<string, number> = {};
  const roomUsage: Record<string, { ref: string; title: string; scheduled: boolean }[]> = {};
  const trackUsage: Record<string, { ref: string; title: string }[]> = {};
  for (const s of subRows) {
    for (const id of s.tagIds ?? []) tagUsage[id] = (tagUsage[id] ?? 0) + 1;
    if (s.roomId) {
      (roomUsage[s.roomId] ??= []).push({
        ref: s.ref,
        title: s.title,
        scheduled: s.startsAt !== null,
      });
    }
    if (s.trackId) {
      (trackUsage[s.trackId] ??= []).push({ ref: s.ref, title: s.title });
    }
  }

  const ruleRows = await db
    .select({
      formId: routingRules.formId,
      assignTagIds: routingRules.assignTagIds,
      assignTrackId: routingRules.assignTrackId,
    })
    .from(routingRules);

  /* A track is also reachable from three places a foreign key cannot
     clean up honestly: a routing rule that assigns it, a task scoped to
     it, and an embed filtered to it. Each is named rather than counted,
     because "in use by 2 things" sends a producer hunting. */
  const trackRules: Record<string, string[]> = {};
  for (const r of ruleRows) {
    if (!r.assignTrackId) continue;
    const name = formNameById.get(r.formId);
    if (!name) continue;
    const arr = (trackRules[r.assignTrackId] ??= []);
    if (!arr.includes(name)) arr.push(name);
  }

  const taskRows = await db
    .select({ id: tasks.id, name: tasks.name, appliesTo: tasks.appliesTo })
    .from(tasks)
    .where(eq(tasks.eventId, DEMO_EVENT_ID));
  const trackTasks: Record<string, string[]> = {};
  for (const t of taskRows) {
    if (!t.appliesTo.startsWith("track:")) continue;
    (trackTasks[t.appliesTo.slice(6)] ??= []).push(t.name);
  }

  const embedRows = await db
    .select({ id: embeds.id, name: embeds.name, filters: embeds.filters })
    .from(embeds)
    .where(eq(embeds.eventId, DEMO_EVENT_ID));
  const trackEmbeds: Record<string, string[]> = {};
  for (const e of embedRows) {
    const t = (e.filters as { track?: unknown } | null)?.track;
    if (typeof t !== "string" || !t) continue;
    (trackEmbeds[t] ??= []).push(e.name);
  }

  const tagRules: Record<string, string[]> = {};
  for (const r of ruleRows) {
    for (const id of r.assignTagIds ?? []) {
      const name = formNameById.get(r.formId);
      if (!name) continue;
      const arr = (tagRules[id] ??= []);
      if (!arr.includes(name)) arr.push(name);
    }
  }

  /* Persona usage: a form's participant rules name roles as strings, so
     a deleted persona would leave a rule pointing at nothing. */
  const personaUsage: Record<string, string[]> = {};
  for (const f of formList) {
    for (const rule of parseRoles(f.participantRoles)) {
      const arr = (personaUsage[rule.role] ??= []);
      if (!arr.includes(f.name)) arr.push(f.name);
    }
  }

  return {
    tab,
    editId: url.searchParams.get("edit"),
    fields: fieldList,
    tagList,
    personaList,
    roomList,
    trackList,
    fieldUsage,
    tagUsage,
    tagRules,
    personaUsage,
    roomUsage,
    trackUsage,
    trackRules,
    trackTasks,
    trackEmbeds,
    palette: DEFAULT_TAG_COLOURS,
    ms: Date.now() - started,
  };
}

/* --- Action --------------------------------------------------------- */

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  /* --- fields ------------------------------------------------------ */

  if (intent === "field_create") {
    const label = String(fd.get("label") ?? "").trim();
    const type = String(fd.get("type") ?? "text");
    if (!label) return { error: "Give the field a label." };
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      return { error: "That is not a field type Callboard knows." };
    }
    const options = parseOptions(String(fd.get("options") ?? ""));
    if (CHOICE_TYPES.includes(type) && options.length === 0) {
      return {
        error: `A ${type} needs at least one option, otherwise submitters cannot answer it.`,
      };
    }

    await db.insert(fieldDefinitions).values({
      eventId: DEMO_EVENT_ID,
      key: await uniqueKey(db, toKey(label)),
      label,
      type,
      options: CHOICE_TYPES.includes(type) ? options : null,
      helpText: String(fd.get("helpText") ?? "").trim() || null,
      validation: buildValidation(fd),
      locked: false,
    });
    return { saved: "Field created." };
  }

  if (intent === "field_update") {
    const id = String(fd.get("id"));
    const existing = await db.query.fieldDefinitions.findFirst({
      where: eq(fieldDefinitions.id, id),
    });
    if (!existing) return { error: "That field no longer exists." };

    const label = String(fd.get("label") ?? "").trim();
    if (!label) return { error: "Give the field a label." };

    /* A locked field is a system field the rest of the app looks up by
       key and expects a particular shape from. Renaming it is safe;
       changing its type is not. */
    if (existing.locked) {
      await db
        .update(fieldDefinitions)
        .set({
          label,
          helpText: String(fd.get("helpText") ?? "").trim() || null,
        })
        .where(eq(fieldDefinitions.id, id));
      return { saved: "Label updated." };
    }

    const type = String(fd.get("type") ?? existing.type);
    const options = parseOptions(String(fd.get("options") ?? ""));
    if (CHOICE_TYPES.includes(type) && options.length === 0) {
      return {
        error: `A ${type} needs at least one option, otherwise submitters cannot answer it.`,
      };
    }

    await db
      .update(fieldDefinitions)
      .set({
        label,
        type,
        options: CHOICE_TYPES.includes(type) ? options : null,
        helpText: String(fd.get("helpText") ?? "").trim() || null,
        validation: buildValidation(fd),
      })
      .where(eq(fieldDefinitions.id, id));
    return { saved: "Field updated." };
  }

  if (intent === "field_delete") {
    const id = String(fd.get("id"));
    const existing = await db.query.fieldDefinitions.findFirst({
      where: eq(fieldDefinitions.id, id),
    });
    if (!existing) return { error: "That field no longer exists." };
    if (existing.locked) {
      return {
        error: `"${existing.label}" is a built in field. It can be relabelled but not removed.`,
      };
    }

    // Deleting cascades to form_fields, so the confirmation has to name
    // what will be pulled off which form.
    await db.delete(fieldDefinitions).where(eq(fieldDefinitions.id, id));
    return { saved: `Deleted "${existing.label}".` };
  }

  /* --- tags -------------------------------------------------------- */

  if (intent === "tag_create") {
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { error: "Give the tag a name." };
    const clash = await db.query.tags.findFirst({
      where: and(eq(tags.eventId, DEMO_EVENT_ID), eq(tags.name, name)),
    });
    if (clash) return { error: `A tag called "${name}" already exists.` };
    await db.insert(tags).values({
      eventId: DEMO_EVENT_ID,
      name,
      color: String(fd.get("color") ?? "#94a3b8"),
    });
    return { saved: "Tag created." };
  }

  if (intent === "tag_update") {
    const id = String(fd.get("id"));
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { error: "Give the tag a name." };
    const clash = await db.query.tags.findFirst({
      where: and(
        eq(tags.eventId, DEMO_EVENT_ID),
        eq(tags.name, name),
        ne(tags.id, id),
      ),
    });
    if (clash) return { error: `A tag called "${name}" already exists.` };
    await db
      .update(tags)
      .set({ name, color: String(fd.get("color") ?? "#94a3b8") })
      .where(eq(tags.id, id));
    return { saved: "Tag updated." };
  }

  if (intent === "tag_delete") {
    const id = String(fd.get("id"));
    /* The tag id lives inside JSON arrays on submissions and routing
       rules, which no foreign key protects, so it is cleaned up here
       rather than left as a dangling reference. */
    const subRows = await db
      .select({ id: submissions.id, tagIds: submissions.tagIds })
      .from(submissions)
      .where(eq(submissions.eventId, DEMO_EVENT_ID));
    for (const s of subRows) {
      if (!s.tagIds?.includes(id)) continue;
      await db
        .update(submissions)
        .set({ tagIds: s.tagIds.filter((t) => t !== id) })
        .where(eq(submissions.id, s.id));
    }
    const rules = await db.select().from(routingRules);
    for (const r of rules) {
      if (!r.assignTagIds?.includes(id)) continue;
      await db
        .update(routingRules)
        .set({ assignTagIds: r.assignTagIds.filter((t) => t !== id) })
        .where(eq(routingRules.id, r.id));
    }
    await db.delete(tags).where(eq(tags.id, id));
    return { saved: "Tag deleted and removed from everything using it." };
  }

  /* --- personas ---------------------------------------------------- */

  if (intent === "persona_create") {
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { error: "Give the role a name." };
    const clash = await db.query.personas.findFirst({
      where: and(eq(personas.eventId, DEMO_EVENT_ID), eq(personas.name, name)),
    });
    if (clash) return { error: `A role called "${name}" already exists.` };
    await db.insert(personas).values({ eventId: DEMO_EVENT_ID, name });
    return { saved: "Role created." };
  }

  if (intent === "persona_update") {
    const id = String(fd.get("id"));
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { error: "Give the role a name." };

    const before = await db.query.personas.findFirst({
      where: eq(personas.id, id),
    });
    if (!before) return { error: "That role no longer exists." };

    /* Participant rules store the role by name, so a rename has to carry
       through or every form quietly loses that rule. */
    const formList = await db
      .select({ id: forms.id, participantRoles: forms.participantRoles })
      .from(forms)
      .where(eq(forms.eventId, DEMO_EVENT_ID));
    for (const f of formList) {
      const rules = f.participantRoles;
      if (!Array.isArray(rules)) continue;
      if (!rules.some((r) => r.role === before.name)) continue;
      await db
        .update(forms)
        .set({
          participantRoles: rules.map((r) =>
            r.role === before.name ? { ...r, role: name } : r,
          ),
        })
        .where(eq(forms.id, f.id));
    }

    await db.update(personas).set({ name }).where(eq(personas.id, id));
    return { saved: `Renamed to "${name}", including on any form using it.` };
  }

  if (intent === "persona_delete") {
    const id = String(fd.get("id"));
    const before = await db.query.personas.findFirst({
      where: eq(personas.id, id),
    });
    if (!before) return { error: "That role no longer exists." };

    // Drop the rule too, so no form is left requiring a role that has
    // ceased to exist.
    const formList = await db
      .select({ id: forms.id, participantRoles: forms.participantRoles })
      .from(forms)
      .where(eq(forms.eventId, DEMO_EVENT_ID));
    for (const f of formList) {
      const rules = f.participantRoles;
      if (!Array.isArray(rules)) continue;
      if (!rules.some((r) => r.role === before.name)) continue;
      await db
        .update(forms)
        .set({ participantRoles: rules.filter((r) => r.role !== before.name) })
        .where(eq(forms.id, f.id));
    }

    await db.delete(personas).where(eq(personas.id, id));
    return { saved: `Deleted "${before.name}".` };
  }

  /* --- rooms ------------------------------------------------------- */

  if (intent === "room_create" || intent === "room_update") {
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { error: "Give the room a name." };

    const id = String(fd.get("id") ?? "");
    const clash = await db.query.rooms.findFirst({
      where: and(
        eq(rooms.eventId, DEMO_EVENT_ID),
        eq(rooms.name, name),
        id ? ne(rooms.id, id) : undefined,
      ),
    });
    if (clash) {
      return {
        error: `A room called "${name}" already exists. Two rooms with one name make the agenda grid unreadable.`,
      };
    }

    const values = {
      name,
      capacity: numberOrNull(fd.get("capacity")),
      sortOrder: Math.trunc(numberOrNull(fd.get("sortOrder")) ?? 0),
    };

    if (intent === "room_create") {
      await db.insert(rooms).values({ eventId: DEMO_EVENT_ID, ...values });
      return { saved: `Room "${name}" created. It is a column on the agenda now.` };
    }
    await db.update(rooms).set(values).where(eq(rooms.id, id));
    return { saved: "Room updated." };
  }

  if (intent === "room_delete") {
    const id = String(fd.get("id"));
    const existing = await db.query.rooms.findFirst({ where: eq(rooms.id, id) });
    if (!existing) return { error: "That room no longer exists." };

    const moveTo = String(fd.get("moveTo") ?? "").trim();
    const inRoom = await db
      .select({ id: submissions.id, ref: submissions.ref })
      .from(submissions)
      .where(eq(submissions.roomId, id));

    if (moveTo) {
      const target = await db.query.rooms.findFirst({
        where: and(eq(rooms.id, moveTo), eq(rooms.eventId, DEMO_EVENT_ID)),
      });
      if (!target) return { error: "That room to move them to no longer exists." };
      await db
        .update(submissions)
        .set({ roomId: moveTo, updatedAt: new Date() })
        .where(eq(submissions.roomId, id));
      await db.delete(rooms).where(eq(rooms.id, id));
      return {
        saved:
          `Deleted "${existing.name}" and moved ${countLabel(inRoom.length, "session")} into ${target.name}` +
          (inRoom.length
            ? `: ${inRoom.map((s) => s.ref).join(", ")}. Check the agenda for double bookings you have just created.`
            : "."),
      };
    }

    /* The foreign key would null these out on its own, which is exactly
       the silent version. Doing it here means the count in the message
       is the real one. */
    await db
      .update(submissions)
      .set({ roomId: null, updatedAt: new Date() })
      .where(eq(submissions.roomId, id));
    await db.delete(rooms).where(eq(rooms.id, id));

    return {
      saved: inRoom.length
        ? `Deleted "${existing.name}". ${countLabel(inRoom.length, "session")} kept the time but no longer have a room: ${inRoom.map((s) => s.ref).join(", ")}. They show as "room to be confirmed" until you place them.`
        : `Deleted "${existing.name}". Nothing was scheduled in it.`,
    };
  }

  /* --- tracks ------------------------------------------------------ */

  if (intent === "track_create" || intent === "track_update") {
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { error: "Give the track a name." };

    const id = String(fd.get("id") ?? "");
    const clash = await db.query.tracks.findFirst({
      where: and(
        eq(tracks.eventId, DEMO_EVENT_ID),
        eq(tracks.name, name),
        id ? ne(tracks.id, id) : undefined,
      ),
    });
    if (clash) return { error: `A track called "${name}" already exists.` };

    const values = {
      name,
      color: String(fd.get("color") ?? "#6366f1"),
      sortOrder: Math.trunc(numberOrNull(fd.get("sortOrder")) ?? 0),
    };

    if (intent === "track_create") {
      await db.insert(tracks).values({ eventId: DEMO_EVENT_ID, ...values });
      return { saved: `Track "${name}" created.` };
    }
    await db.update(tracks).set(values).where(eq(tracks.id, id));
    return { saved: "Track updated." };
  }

  if (intent === "track_delete") {
    const id = String(fd.get("id"));
    const existing = await db.query.tracks.findFirst({
      where: eq(tracks.id, id),
    });
    if (!existing) return { error: "That track no longer exists." };

    const moveTo = String(fd.get("moveTo") ?? "").trim();
    const target = moveTo
      ? await db.query.tracks.findFirst({
          where: and(eq(tracks.id, moveTo), eq(tracks.eventId, DEMO_EVENT_ID)),
        })
      : null;
    if (moveTo && !target) {
      return { error: "That track to move them to no longer exists." };
    }

    const onTrack = await db
      .select({ ref: submissions.ref })
      .from(submissions)
      .where(eq(submissions.trackId, id));

    const rules = await db
      .select({ id: routingRules.id })
      .from(routingRules)
      .where(eq(routingRules.assignTrackId, id));

    const scopedTasks = await db
      .select({ id: tasks.id, name: tasks.name })
      .from(tasks)
      .where(
        and(eq(tasks.eventId, DEMO_EVENT_ID), eq(tasks.appliesTo, `track:${id}`)),
      );

    const embedRows = await db
      .select({ id: embeds.id, name: embeds.name, filters: embeds.filters })
      .from(embeds)
      .where(eq(embeds.eventId, DEMO_EVENT_ID));
    const filtered = embedRows.filter(
      (e) => (e.filters as { track?: unknown } | null)?.track === id,
    );

    await db
      .update(submissions)
      .set({ trackId: target ? target.id : null, updatedAt: new Date() })
      .where(eq(submissions.trackId, id));

    await db
      .update(routingRules)
      .set({ assignTrackId: target ? target.id : null })
      .where(eq(routingRules.assignTrackId, id));

    /* An embed filtered to a track that no longer exists renders an
       empty programme to the public and nobody finds out until somebody
       complains, so the filter is either re-pointed or dropped. Both
       are stated in the message rather than left to be discovered. */
    for (const e of filtered) {
      const next = { ...(e.filters as Record<string, unknown>) };
      if (target) next.track = target.id;
      else delete next.track;
      await db.update(embeds).set({ filters: next }).where(eq(embeds.id, e.id));
    }

    /* Tasks are the one reference not rewritten when there is nowhere to
       move them to. A task carries real completion records for real
       people, and quietly widening its audience to every accepted
       speaker would assign work to people nobody meant to ask. It keeps
       pointing at the removed track, the Tasks screen already labels
       that "a deleted track", and the message below says so. */
    if (target) {
      await db
        .update(tasks)
        .set({ appliesTo: `track:${target.id}` })
        .where(
          and(
            eq(tasks.eventId, DEMO_EVENT_ID),
            eq(tasks.appliesTo, `track:${id}`),
          ),
        );
    }

    await db.delete(tracks).where(eq(tracks.id, id));

    const moved: string[] = [];
    if (onTrack.length) moved.push(countLabel(onTrack.length, "submission"));
    if (rules.length) moved.push(countLabel(rules.length, "routing rule"));
    if (scopedTasks.length) {
      moved.push(
        `${countLabel(scopedTasks.length, "task")} (${scopedTasks.map((t) => t.name).join(", ")})`,
      );
    }
    if (filtered.length) {
      moved.push(
        `${countLabel(filtered.length, "embed")} (${filtered.map((e) => e.name).join(", ")})`,
      );
    }

    if (target) {
      return {
        saved: moved.length
          ? `Deleted "${existing.name}" and moved ${moved.join(", ")} to ${target.name}.`
          : `Deleted "${existing.name}". Nothing was using it.`,
      };
    }

    const cleared: string[] = [];
    if (onTrack.length)
      cleared.push(`${countLabel(onTrack.length, "submission")} now has no track`);
    if (rules.length)
      cleared.push(
        `${countLabel(rules.length, "routing rule")} no longer assigns one`,
      );
    if (filtered.length)
      cleared.push(
        `${countLabel(filtered.length, "embed")} now shows every track rather than an empty page`,
      );

    const orphaned = scopedTasks.length
      ? ` ${countLabel(scopedTasks.length, "task")} still points at it and now applies to nobody: ${scopedTasks.map((t) => t.name).join(", ")}. Give it a new audience on Tasks.`
      : "";

    return {
      saved:
        (cleared.length
          ? `Deleted "${existing.name}". ${cleared.join(", ")}.`
          : `Deleted "${existing.name}". Nothing was using it.`) + orphaned,
    };
  }

  return { error: "Unknown action." };
}

function numberOrNull(raw: FormDataEntryValue | null): number | null {
  const v = String(raw ?? "").trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function countLabel(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/* --- UI -------------------------------------------------------------- */

const field =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong";

export default function Library() {
  const {
    tab,
    editId,
    fields,
    tagList,
    personaList,
    roomList,
    trackList,
    fieldUsage,
    tagUsage,
    tagRules,
    personaUsage,
    roomUsage,
    trackUsage,
    trackRules,
    trackTasks,
    trackEmbeds,
    palette,
    ms,
  } = useLoaderData<typeof loader>();
  const action = useActionData<{ error?: string; saved?: string }>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [params] = useSearchParams();

  const tabHref = (t: Tab) => {
    const n = new URLSearchParams(params);
    n.set("tab", t);
    n.delete("edit");
    return `?${n}`;
  };
  const editHref = (id: string | null) => {
    const n = new URLSearchParams(params);
    if (id) n.set("edit", id);
    else n.delete("edit");
    return `?${n}`;
  };

  const editingField = fields.find((f) => f.id === editId);

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Library</h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Defined once for the event, then reused on every form. Changing
              something here changes it everywhere it appears.
            </p>
          </div>
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim" title="Time spent in this page's loader fetching data. It excludes rendering, so it is not total server time: that is in the Server-Timing response header.">
            data {ms} ms
          </div>
        </div>

        <div className="mt-4 flex gap-1">
          {TABS.map((t) => (
            <Link
              key={t}
              to={tabHref(t)}
              prefetch="intent"
              className={[
                "flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] capitalize transition-colors",
                t === tab
                  ? "border-accent-solid font-medium text-accent-text"
                  : "border-transparent text-dim hover:text-strong",
              ].join(" ")}
            >
              {t}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-dim">
                {
                  {
                    fields: fields.length,
                    tags: tagList.length,
                    personas: personaList.length,
                    rooms: roomList.length,
                    tracks: trackList.length,
                  }[t]
                }
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="max-w-4xl px-6 py-4">
        {action?.error && (
          <p className="cb-note cb-note-danger mb-4 px-3 py-2.5 text-[13px]">
            {action.error}
          </p>
        )}
        {action?.saved && (
          <p className="cb-note cb-note-success mb-4 px-3 py-2.5 text-[13px]">
            {action.saved}
          </p>
        )}

        {tab === "fields" && (
          <FieldsTab
            fields={fields}
            usage={fieldUsage}
            editing={editingField}
            editHref={editHref}
            busy={busy}
          />
        )}

        {tab === "tags" && (
          <TagsTab
            tagList={tagList}
            usage={tagUsage}
            rules={tagRules}
            palette={palette}
            busy={busy}
          />
        )}

        {tab === "personas" && (
          <PersonasTab
            personaList={personaList}
            usage={personaUsage}
            busy={busy}
          />
        )}

        {tab === "rooms" && (
          <RoomsTab roomList={roomList} usage={roomUsage} busy={busy} />
        )}

        {tab === "tracks" && (
          <TracksTab
            trackList={trackList}
            usage={trackUsage}
            rules={trackRules}
            taskNames={trackTasks}
            embedNames={trackEmbeds}
            palette={palette}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}

/* --- Fields ---------------------------------------------------------- */

type FieldRow = ReturnType<typeof useLoaderData<typeof loader>>["fields"][number];

function FieldEditor({
  existing,
  busy,
}: {
  existing?: FieldRow;
  busy: boolean;
}) {
  const isEdit = Boolean(existing);
  const locked = existing?.locked ?? false;

  return (
    <Form
      method="post"
      className="space-y-3 rounded-lg border border-line bg-surface p-4"
    >
      <input
        type="hidden"
        name="intent"
        value={isEdit ? "field_update" : "field_create"}
      />
      {existing && <input type="hidden" name="id" value={existing.id} />}

      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">
          {isEdit ? `Edit ${existing!.label}` : "New field"}
        </h3>
        {locked && (
          <span className="cb-pill cb-pill-neutral">built in</span>
        )}
      </div>

      {locked && (
        <p className="text-[12px] text-dim">
          This is a system field. The rest of Callboard looks it up by its key
          and expects a particular shape, so the label and help text can change
          but the type cannot.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] font-medium">Label</span>
          <input
            name="label"
            defaultValue={existing?.label ?? ""}
            className={field}
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Type</span>
          <select
            name="type"
            defaultValue={existing?.type ?? "text"}
            disabled={locked}
            className={field}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {existing && (
        <p className="text-[12px] text-dim">
          Key <span className="font-mono text-body">{existing.key}</span>. Fixed
          once created, because forms and stored answers reference it.
        </p>
      )}

      {!locked && (
        <label className="block">
          <span className="text-[13px] font-medium">
            Options, one per line
          </span>
          <span className="block text-[12px] text-dim">
            Only used by dropdown, multiselect and radio.
          </span>
          <textarea
            name="options"
            rows={4}
            defaultValue={(existing?.options ?? []).join("\n")}
            className={`${field} font-mono`}
          />
        </label>
      )}

      <label className="block">
        <span className="text-[13px] font-medium">Help text</span>
        <input
          name="helpText"
          defaultValue={existing?.helpText ?? ""}
          className={field}
        />
      </label>

      {!locked && (
        <fieldset className="rounded-md border border-line-soft p-3">
          <legend className="px-1 text-[12px] font-medium text-dim">
            Validation
          </legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ["maxLength", "Max characters", "number"],
                ["min", "Minimum", "number"],
                ["max", "Maximum", "number"],
                ["pattern", "Pattern", "text"],
                ["accept", "Accepted files", "text"],
              ] as const
            ).map(([name, label, type]) => (
              <label key={name} className="block">
                <span className="text-[12px] text-dim">{label}</span>
                <input
                  name={name}
                  type={type}
                  defaultValue={
                    (existing?.validation as Record<string, unknown> | null)?.[
                      name
                    ] as string | number | undefined
                  }
                  className={field}
                />
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          {busy ? "Saving" : isEdit ? "Save field" : "Create field"}
        </button>
        {isEdit && (
          <Link
            to="?tab=fields"
            className="cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]"
          >
            Cancel
          </Link>
        )}
      </div>
    </Form>
  );
}

function FieldsTab({
  fields,
  usage,
  editing,
  editHref,
  busy,
}: {
  fields: FieldRow[];
  usage: Record<string, string[]>;
  editing?: FieldRow;
  editHref: (id: string | null) => string;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="cb-thead text-[11px] uppercase tracking-[0.06em]">
              <th className="px-4 py-2 font-medium">Label</th>
              <th className="px-4 py-2 font-medium">Key</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Used on</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => {
              const used = usage[f.id] ?? [];
              return (
                <tr
                  key={f.id}
                  className="cb-row-hover border-b border-line-soft last:border-0"
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-strong">{f.label}</span>
                    {f.locked && (
                      <span className="ml-1.5 cb-pill cb-pill-neutral">
                        built in
                      </span>
                    )}
                    {Array.isArray(f.options) && f.options.length > 0 && (
                      <span className="ml-1.5 text-[12px] text-dim">
                        {f.options.length} options
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-dim">
                    {f.key}
                  </td>
                  <td className="px-4 py-2.5 text-body">{f.type}</td>
                  <td className="px-4 py-2.5 text-dim">
                    {used.length === 0 ? (
                      <span className="text-faint">Not used</span>
                    ) : (
                      used.join(", ")
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <Link
                      to={editHref(f.id)}
                      className="text-[12px] text-accent-text underline-offset-2 hover:underline"
                    >
                      Edit
                    </Link>
                    {!f.locked && (
                      <Form method="post" className="ml-2 inline">
                        <input type="hidden" name="intent" value="field_delete" />
                        <input type="hidden" name="id" value={f.id} />
                        <button
                          disabled={busy}
                          onClick={(e) => {
                            const msg =
                              used.length > 0
                                ? `"${f.label}" is on ${used.length} form${used.length > 1 ? "s" : ""}: ${used.join(", ")}.\n\nDeleting it removes the question from ${used.length > 1 ? "those forms" : "that form"}. Answers already submitted stay on the submission but nothing will display them.\n\nDelete anyway?`
                                : `Delete "${f.label}"? It is not on any form.`;
                            if (!confirm(msg)) e.preventDefault();
                          }}
                          className="text-[12px] text-danger underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </Form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FieldEditor existing={editing} busy={busy} key={editing?.id ?? "new"} />
    </div>
  );
}

/* --- Tags ------------------------------------------------------------ */

function TagsTab({
  tagList,
  usage,
  rules,
  palette,
  busy,
}: {
  tagList: { id: string; name: string; color: string }[];
  usage: Record<string, number>;
  rules: Record<string, string[]>;
  palette: string[];
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
        {tagList.length === 0 && (
          <li className="px-4 py-10 text-center text-[13px] text-dim">
            No tags yet.
          </li>
        )}
        {tagList.map((t) => {
          const count = usage[t.id] ?? 0;
          const usedByRules = rules[t.id] ?? [];
          return (
            <li key={t.id} className="p-3">
              <Form method="post" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="intent" value="tag_update" />
                <input type="hidden" name="id" value={t.id} />
                <span
                  className="cb-chip"
                  style={{ "--cb-hue": t.color } as React.CSSProperties}
                >
                  {t.name}
                </span>
                <input
                  name="name"
                  defaultValue={t.name}
                  className="w-48 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
                />
                <input
                  name="color"
                  type="color"
                  defaultValue={t.color}
                  aria-label={`Colour for ${t.name}`}
                  className="h-8 w-12 rounded border border-line-strong bg-surface"
                />
                <span className="text-[12px] text-dim tabular-nums">
                  {count} submission{count === 1 ? "" : "s"}
                  {usedByRules.length > 0 &&
                    `, applied by a rule on ${usedByRules.join(", ")}`}
                </span>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    disabled={busy}
                    className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
                  >
                    Save
                  </button>
                  <button
                    formAction="/admin/library?tab=tags"
                    name="intent"
                    value="tag_delete"
                    disabled={busy}
                    onClick={(e) => {
                      const bits = [];
                      if (count > 0)
                        bits.push(
                          `${count} submission${count > 1 ? "s" : ""} carry it`,
                        );
                      if (usedByRules.length > 0)
                        bits.push(
                          `a routing rule on ${usedByRules.join(", ")} applies it`,
                        );
                      const msg = bits.length
                        ? `"${t.name}" is in use: ${bits.join(", and ")}.\n\nDeleting removes it from all of them.\n\nDelete anyway?`
                        : `Delete "${t.name}"? Nothing is using it.`;
                      if (!confirm(msg)) e.preventDefault();
                    }}
                    className="cb-btn cb-btn-danger px-2 py-1 text-[12px]"
                  >
                    Delete
                  </button>
                </div>
              </Form>
            </li>
          );
        })}
      </ul>

      <Form
        method="post"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <input type="hidden" name="intent" value="tag_create" />
        <label className="block">
          <span className="text-[13px] font-medium">New tag</span>
          <input name="name" placeholder="Sponsor Session" className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Colour</span>
          <input
            name="color"
            type="color"
            defaultValue={palette[0]}
            className="mt-1 block h-9 w-16 rounded border border-line-strong bg-surface"
          />
        </label>
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          Add tag
        </button>
      </Form>
    </div>
  );
}

/* --- Personas -------------------------------------------------------- */

function PersonasTab({
  personaList,
  usage,
  busy,
}: {
  personaList: { id: string; name: string }[];
  usage: Record<string, string[]>;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-dim">
        Roles a submission's participants can hold. These are what the form
        builder offers under "Who submitters can add".
      </p>

      <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
        {personaList.length === 0 && (
          <li className="px-4 py-10 text-center text-[13px] text-dim">
            No roles yet. Without at least one, forms fall back to a single
            Speaker.
          </li>
        )}
        {personaList.map((p) => {
          const used = usage[p.name] ?? [];
          return (
            <li key={p.id} className="p-3">
              <Form method="post" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="intent" value="persona_update" />
                <input type="hidden" name="id" value={p.id} />
                <input
                  name="name"
                  defaultValue={p.name}
                  className="w-56 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong"
                />
                <span className="text-[12px] text-dim">
                  {used.length === 0
                    ? "Not used by any form"
                    : `Used by ${used.join(", ")}`}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    disabled={busy}
                    className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
                  >
                    Save
                  </button>
                  <button
                    formAction="/admin/library?tab=personas"
                    name="intent"
                    value="persona_delete"
                    disabled={busy}
                    onClick={(e) => {
                      const msg =
                        used.length > 0
                          ? `"${p.name}" is used by the participant rules on ${used.join(", ")}.\n\nDeleting removes that rule, so those forms will no longer offer the role.\n\nDelete anyway?`
                          : `Delete the "${p.name}" role? No form uses it.`;
                      if (!confirm(msg)) e.preventDefault();
                    }}
                    className="cb-btn cb-btn-danger px-2 py-1 text-[12px]"
                  >
                    Delete
                  </button>
                </div>
              </Form>
            </li>
          );
        })}
      </ul>

      <Form
        method="post"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <input type="hidden" name="intent" value="persona_create" />
        <label className="block">
          <span className="text-[13px] font-medium">New role</span>
          <input name="name" placeholder="Panelist" className={field} />
        </label>
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          Add role
        </button>
      </Form>
    </div>
  );
}

/* --- Rooms ----------------------------------------------------------- */

const rowInput =
  "rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-strong";

/* The refs, up to a handful, then a count. A producer needs to
   recognise what they are about to disturb, not read all forty. */
function refList(refs: string[], limit = 5) {
  return refs.length <= limit
    ? refs.join(", ")
    : `${refs.slice(0, limit).join(", ")} and ${refs.length - limit} more`;
}

/* Reads the "move them to" choice out of the row's own form at click
   time, so the confirmation describes the delete that is about to
   happen rather than the one the producer started with. */
function moveTarget(
  e: React.MouseEvent<HTMLButtonElement>,
  options: { id: string; name: string }[],
) {
  const select = e.currentTarget.form?.elements.namedItem("moveTo");
  const value = select instanceof HTMLSelectElement ? select.value : "";
  return value ? (options.find((o) => o.id === value) ?? null) : null;
}

function RoomsTab({
  roomList,
  usage,
  busy,
}: {
  roomList: { id: string; name: string; capacity: number | null; sortOrder: number }[];
  usage: Record<string, { ref: string; title: string; scheduled: boolean }[]>;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-dim">
        The columns on the{" "}
        <Link
          to="/admin/agenda"
          className="text-accent-text underline underline-offset-2"
        >
          agenda grid
        </Link>
        , in this order. Capacity is shown beside the name there, so a
        producer can see at a glance when a popular talk is in the small
        room.
      </p>

      <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
        {roomList.length === 0 && (
          <li className="px-4 py-10 text-center text-[13px] text-dim">
            No rooms yet. The agenda grid has nothing to put sessions in until
            there is at least one.
          </li>
        )}
        {roomList.map((r) => {
          const used = usage[r.id] ?? [];
          const others = roomList.filter((o) => o.id !== r.id);
          return (
            <li key={r.id} className="p-3">
              <Form method="post">
                <input type="hidden" name="intent" value="room_update" />
                <input type="hidden" name="id" value={r.id} />
                <div className="flex flex-wrap items-center gap-2">
                <input
                  name="name"
                  defaultValue={r.name}
                  aria-label={`Name of ${r.name}`}
                  className={`${rowInput} w-48`}
                />
                <label className="flex items-center gap-1.5 text-[12px] text-dim">
                  Seats
                  <input
                    name="capacity"
                    type="number"
                    min={0}
                    defaultValue={r.capacity ?? ""}
                    className={`${rowInput} w-20`}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-dim">
                  Order
                  <input
                    name="sortOrder"
                    type="number"
                    defaultValue={r.sortOrder}
                    className={`${rowInput} w-16`}
                  />
                </label>

                <div className="ml-auto flex items-center gap-2">
                  {used.length > 0 && others.length > 0 && (
                    <select
                      name="moveTo"
                      aria-label={`On delete, move sessions out of ${r.name} to`}
                      className={`${rowInput} w-44`}
                      defaultValue=""
                      title="What happens to the sessions in this room if you delete it"
                    >
                      <option value="">Delete leaves them roomless</option>
                      {others.map((o) => (
                        <option key={o.id} value={o.id}>
                          Delete moves them to {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    disabled={busy}
                    className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
                  >
                    Save
                  </button>
                  <button
                    formAction="/admin/library?tab=rooms"
                    name="intent"
                    value="room_delete"
                    disabled={busy}
                    onClick={(e) => {
                      const target = moveTarget(e, others);
                      const msg = used.length
                        ? `"${r.name}" has ${used.length} session${used.length === 1 ? "" : "s"} in it: ${refList(used.map((s) => s.ref))}.\n\n` +
                          (target
                            ? `Deleting moves ${used.length === 1 ? "it" : "them"} into ${target.name}, keeping the same times. Check the agenda afterwards: two sessions at one time in one room is a conflict.\n\nDelete anyway?`
                            : `Deleting keeps their times and leaves them with no room, showing as "room to be confirmed" until you place them again.\n\nDelete anyway?`)
                        : `Delete "${r.name}"? Nothing is scheduled in it.`;
                      if (!confirm(msg)) e.preventDefault();
                    }}
                    className="cb-btn cb-btn-danger px-2 py-1 text-[12px]"
                  >
                    Delete
                  </button>
                </div>
                </div>

                <p className="mt-1.5 text-[12px] text-dim">
                  {used.length === 0
                    ? "Nothing scheduled here"
                    : `${used.length} session${used.length === 1 ? "" : "s"}: ${refList(used.map((s) => s.ref))}`}
                </p>
              </Form>
            </li>
          );
        })}
      </ul>

      <Form
        method="post"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <input type="hidden" name="intent" value="room_create" />
        <label className="block">
          <span className="text-[13px] font-medium">New room</span>
          <input name="name" placeholder="Golden Gate Ballroom" className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Seats</span>
          <input
            name="capacity"
            type="number"
            min={0}
            placeholder="400"
            className={`${field} w-28`}
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Order</span>
          <input
            name="sortOrder"
            type="number"
            defaultValue={roomList.length}
            className={`${field} w-24`}
          />
        </label>
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          Add room
        </button>
      </Form>
    </div>
  );
}

/* --- Tracks ---------------------------------------------------------- */

function TracksTab({
  trackList,
  usage,
  rules,
  taskNames,
  embedNames,
  palette,
  busy,
}: {
  trackList: { id: string; name: string; color: string; sortOrder: number }[];
  usage: Record<string, { ref: string; title: string }[]>;
  rules: Record<string, string[]>;
  taskNames: Record<string, string[]>;
  embedNames: Record<string, string[]>;
  palette: string[];
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-dim">
        The programme's subject strands. The colour is the dot that identifies
        a session everywhere it appears: the submissions list, the{" "}
        <Link
          to="/admin/agenda?view=track"
          className="text-accent-text underline underline-offset-2"
        >
          agenda
        </Link>{" "}
        and the public programme.
      </p>

      <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
        {trackList.length === 0 && (
          <li className="px-4 py-10 text-center text-[13px] text-dim">
            No tracks yet. Submissions can still be collected and scheduled;
            they just will not be grouped by subject anywhere.
          </li>
        )}
        {trackList.map((t) => {
          const subs = usage[t.id] ?? [];
          const usedByRules = rules[t.id] ?? [];
          const usedByTasks = taskNames[t.id] ?? [];
          const usedByEmbeds = embedNames[t.id] ?? [];
          const others = trackList.filter((o) => o.id !== t.id);

          const usageBits = [
            subs.length ? `${subs.length} submission${subs.length === 1 ? "" : "s"}` : null,
            usedByRules.length ? `assigned by a rule on ${usedByRules.join(", ")}` : null,
            usedByTasks.length ? `scoping ${usedByTasks.join(", ")}` : null,
            usedByEmbeds.length ? `filtering ${usedByEmbeds.join(", ")}` : null,
          ].filter(Boolean) as string[];

          return (
            <li key={t.id} className="p-3">
              <Form method="post">
                <input type="hidden" name="intent" value="track_update" />
                <input type="hidden" name="id" value={t.id} />
                <div className="flex flex-wrap items-center gap-2">
                <span
                  className="cb-dot h-2.5 w-2.5 shrink-0"
                  style={{ ["--cb-hue"]: t.color } as React.CSSProperties}
                />
                <input
                  name="name"
                  defaultValue={t.name}
                  aria-label={`Name of ${t.name}`}
                  className={`${rowInput} w-48`}
                />
                <input
                  name="color"
                  type="color"
                  defaultValue={t.color}
                  aria-label={`Colour for ${t.name}`}
                  className="h-8 w-12 rounded border border-line-strong bg-surface"
                />
                <label className="flex items-center gap-1.5 text-[12px] text-dim">
                  Order
                  <input
                    name="sortOrder"
                    type="number"
                    defaultValue={t.sortOrder}
                    className={`${rowInput} w-16`}
                  />
                </label>
                <div className="ml-auto flex items-center gap-2">
                  {usageBits.length > 0 && others.length > 0 && (
                    <select
                      name="moveTo"
                      aria-label={`On delete, move everything on ${t.name} to`}
                      className={`${rowInput} w-44`}
                      defaultValue=""
                      title="What happens to everything on this track if you delete it"
                    >
                      <option value="">Delete clears the track</option>
                      {others.map((o) => (
                        <option key={o.id} value={o.id}>
                          Delete moves it to {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    disabled={busy}
                    className="cb-btn cb-btn-secondary px-2 py-1 text-[12px]"
                  >
                    Save
                  </button>
                  <button
                    formAction="/admin/library?tab=tracks"
                    name="intent"
                    value="track_delete"
                    disabled={busy}
                    onClick={(e) => {
                      const target = moveTarget(e, others);
                      if (!usageBits.length) {
                        if (!confirm(`Delete "${t.name}"? Nothing is using it.`))
                          e.preventDefault();
                        return;
                      }

                      const affected = [
                        subs.length
                          ? `${subs.length} submission${subs.length === 1 ? "" : "s"} (${refList(subs.map((s) => s.ref))})`
                          : null,
                        usedByRules.length
                          ? `a routing rule on ${usedByRules.join(", ")}`
                          : null,
                        usedByTasks.length
                          ? `the task${usedByTasks.length === 1 ? "" : "s"} ${usedByTasks.join(", ")}`
                          : null,
                        usedByEmbeds.length
                          ? `the embed${usedByEmbeds.length === 1 ? "" : "s"} ${usedByEmbeds.join(", ")}`
                          : null,
                      ].filter(Boolean);

                      const consequence = target
                        ? `All of it moves to ${target.name}.`
                        : [
                            subs.length ? "The submissions keep everything else and lose their track." : null,
                            usedByRules.length ? "The rule stops assigning a track." : null,
                            usedByEmbeds.length ? "The embed shows every track instead of an empty page." : null,
                            usedByTasks.length
                              ? `${usedByTasks.join(", ")} will apply to nobody until you give it a new audience on Tasks.`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" ");

                      const msg = `"${t.name}" is in use by ${affected.join(", ")}.\n\n${consequence}\n\nDelete anyway?`;
                      if (!confirm(msg)) e.preventDefault();
                    }}
                    className="cb-btn cb-btn-danger px-2 py-1 text-[12px]"
                  >
                    Delete
                  </button>
                </div>
                </div>

                <p className="mt-1.5 text-[12px] text-dim">
                  {usageBits.length ? usageBits.join(", ") : "Not used anywhere"}
                </p>
              </Form>
            </li>
          );
        })}
      </ul>

      <Form
        method="post"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <input type="hidden" name="intent" value="track_create" />
        <label className="block">
          <span className="text-[13px] font-medium">New track</span>
          <input name="name" placeholder="Agents & Tool Use" className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Colour</span>
          <input
            name="color"
            type="color"
            defaultValue={palette[trackList.length % palette.length]}
            className="mt-1 block h-9 w-16 rounded border border-line-strong bg-surface"
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Order</span>
          <input
            name="sortOrder"
            type="number"
            defaultValue={trackList.length}
            className={`${field} w-24`}
          />
        </label>
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          Add track
        </button>
      </Form>
    </div>
  );
}
