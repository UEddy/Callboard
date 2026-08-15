import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  events,
  personas,
  taskAssignments,
  tasks,
  tracks,
} from "~/db/schema";
import {
  TASK_KINDS,
  assignmentImpact,
  describeAppliesTo,
  kindLabel,
  nextSortOrder,
  resolveAudience,
  syncTaskAssignments,
} from "~/lib/tasks";
import { dayIsoIn, fmtDateIn, safeZone, wallToUtc } from "~/lib/tz";

/* ------------------------------------------------------------------ *
 * Onboarding tasks.
 *
 * A task here is a promise to chase somebody, so creating one has to
 * actually reach people: the assignments are generated on save rather
 * than lazily, which is what makes the onboarding board and the
 * dashboard counts real the moment the task exists.
 * ------------------------------------------------------------------ */

function dueInputToDate(value: string, zone: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  // End of the day in the event's zone: a task due "the 27th" is not
  // overdue at one minute past midnight.
  return new Date(wallToUtc(+m[1], +m[2], +m[3], 23, 59, zone));
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  const zone = safeZone(event?.timezone);

  const [taskList, trackList, personaList] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(eq(tasks.eventId, DEMO_EVENT_ID))
      .orderBy(asc(tasks.sortOrder)),
    db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.eventId, DEMO_EVENT_ID))
      .orderBy(asc(tracks.sortOrder)),
    db
      .select({ id: personas.id, name: personas.name })
      .from(personas)
      .where(eq(personas.eventId, DEMO_EVENT_ID))
      .orderBy(asc(personas.name)),
  ]);

  const assignmentRows = taskList.length
    ? await db
        .select({
          taskId: taskAssignments.taskId,
          participantId: taskAssignments.participantId,
          status: taskAssignments.status,
        })
        .from(taskAssignments)
        .where(
          inArray(
            taskAssignments.taskId,
            taskList.map((t) => t.id),
          ),
        )
    : [];

  const progress: Record<string, { total: number; done: number }> = {};
  for (const a of assignmentRows) {
    const p = (progress[a.taskId] ??= { total: 0, done: 0 });
    p.total++;
    if (a.status === "complete" || a.status === "waived") p.done++;
  }

  const trackNames = new Map(trackList.map((t) => [t.id, t.name]));
  const personaNames = new Map(personaList.map((p) => [p.id, p.name]));

  /* How many people each task would reach if synced now, so a producer
     can see when an audience has grown since the task was made. */
  const audienceSize: Record<string, number> = {};
  for (const t of taskList) {
    audienceSize[t.id] = (
      await resolveAudience(db, DEMO_EVENT_ID, t.appliesTo, personaNames)
    ).length;
  }

  return {
    zone,
    editId: url.searchParams.get("edit"),
    creating: url.searchParams.get("new") === "1",
    tasks: taskList.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      kind: t.kind,
      appliesTo: t.appliesTo,
      appliesToLabel: describeAppliesTo(t.appliesTo, trackNames, personaNames),
      required: t.required,
      sortOrder: t.sortOrder,
      dueAt: t.dueAt ? new Date(t.dueAt).getTime() : null,
      dueInput: t.dueAt ? dayIsoIn(new Date(t.dueAt).getTime(), zone) : "",
      done: progress[t.id]?.done ?? 0,
      assigned: progress[t.id]?.total ?? 0,
      audience: audienceSize[t.id] ?? 0,
    })),
    trackList,
    personaList,
    ms: Date.now() - started,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });
  const zone = safeZone(event?.timezone);

  const personaList = await db
    .select({ id: personas.id, name: personas.name })
    .from(personas)
    .where(eq(personas.eventId, DEMO_EVENT_ID));
  const personaNames = new Map(personaList.map((p) => [p.id, p.name]));

  if (intent === "create" || intent === "update") {
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return { error: "Give the task a name." };

    const kind = String(fd.get("kind") ?? "custom");
    if (!TASK_KINDS.some((k) => k.value === kind)) {
      return { error: "That is not a task kind Callboard knows." };
    }

    const scope = String(fd.get("scope") ?? "all");
    const appliesTo =
      scope === "track"
        ? `track:${String(fd.get("trackId") ?? "")}`
        : scope === "persona"
          ? `persona:${String(fd.get("personaId") ?? "")}`
          : "all_accepted_speakers";

    if (scope === "track" && !fd.get("trackId")) {
      return { error: "Pick which track this applies to." };
    }
    if (scope === "persona" && !fd.get("personaId")) {
      return { error: "Pick which role this applies to." };
    }

    const values = {
      name,
      description: String(fd.get("description") ?? "").trim() || null,
      kind,
      appliesTo,
      dueAt: dueInputToDate(String(fd.get("dueAt") ?? ""), zone),
      required: fd.get("required") === "on",
    };

    let taskId: string;
    if (intent === "create") {
      taskId = crypto.randomUUID();
      await db.insert(tasks).values({
        id: taskId,
        eventId: DEMO_EVENT_ID,
        sortOrder: await nextSortOrder(db, DEMO_EVENT_ID),
        ...values,
      });
    } else {
      taskId = String(fd.get("id"));
      await db.update(tasks).set(values).where(eq(tasks.id, taskId));
    }

    /* The whole point of a task is that somebody is chased for it, so
       the assignments are created here rather than waiting for someone
       to open the onboarding board. */
    const sync = await syncTaskAssignments(
      db,
      DEMO_EVENT_ID,
      taskId,
      appliesTo,
      personaNames,
    );

    const bits = [
      intent === "create" ? "Task created" : "Task updated",
      sync.added
        ? `assigned to ${sync.added} speaker${sync.added === 1 ? "" : "s"}`
        : null,
      sync.removed
        ? `withdrawn from ${sync.removed} who no longer qualify and had not started`
        : null,
    ].filter(Boolean);

    return { saved: `${bits.join(", ")}.` };
  }

  if (intent === "delete") {
    const id = String(fd.get("id"));
    const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!existing) return { error: "That task no longer exists." };

    const impact = await assignmentImpact(db, id);
    // Cascade would handle this, but doing it explicitly keeps the count
    // honest in the message rather than guessed.
    await db.delete(taskAssignments).where(eq(taskAssignments.taskId, id));
    await db.delete(tasks).where(eq(tasks.id, id));

    return {
      saved:
        `Deleted "${existing.name}" and removed it from ${impact.speakers} speaker${impact.speakers === 1 ? "" : "s"}` +
        (impact.done
          ? `, including ${impact.done} who had already completed it.`
          : "."),
    };
  }

  if (intent === "move") {
    const id = String(fd.get("id"));
    const dir = Number(fd.get("dir"));
    const all = await db
      .select()
      .from(tasks)
      .where(eq(tasks.eventId, DEMO_EVENT_ID))
      .orderBy(asc(tasks.sortOrder));
    const i = all.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i >= 0 && j >= 0 && j < all.length) {
      await db
        .update(tasks)
        .set({ sortOrder: all[j].sortOrder })
        .where(eq(tasks.id, all[i].id));
      await db
        .update(tasks)
        .set({ sortOrder: all[i].sortOrder })
        .where(eq(tasks.id, all[j].id));
    }
    return { ok: true };
  }

  if (intent === "resync") {
    const id = String(fd.get("id"));
    const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!existing) return { error: "That task no longer exists." };
    const sync = await syncTaskAssignments(
      db,
      DEMO_EVENT_ID,
      id,
      existing.appliesTo,
      personaNames,
    );
    return {
      saved: sync.added
        ? `Assigned to ${sync.added} more speaker${sync.added === 1 ? "" : "s"}.`
        : "Everyone it applies to already has it.",
    };
  }

  return { error: "Unknown action." };
}

/* --- UI --------------------------------------------------------------- */

const field =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong";

type TaskRow = ReturnType<typeof useLoaderData<typeof loader>>["tasks"][number];

function TaskEditor({
  task,
  trackList,
  personaList,
  busy,
}: {
  task?: TaskRow;
  trackList: { id: string; name: string }[];
  personaList: { id: string; name: string }[];
  busy: boolean;
}) {
  const isEdit = Boolean(task);
  const applies = task?.appliesTo ?? "all_accepted_speakers";
  const scope = applies.startsWith("track:")
    ? "track"
    : applies.startsWith("persona:")
      ? "persona"
      : "all";

  return (
    <Form
      method="post"
      className="space-y-3 rounded-lg border border-line bg-surface p-4"
    >
      <input type="hidden" name="intent" value={isEdit ? "update" : "create"} />
      {task && <input type="hidden" name="id" value={task.id} />}

      <h3 className="text-[14px] font-semibold">
        {isEdit ? `Edit ${task!.name}` : "New task"}
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] font-medium">Name</span>
          <input name="name" defaultValue={task?.name ?? ""} className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Kind</span>
          <select name="kind" defaultValue={task?.kind ?? "custom"} className={field}>
            {TASK_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-[13px] font-medium">Description</span>
        <span className="block text-[12px] text-dim">
          Shown to the speaker in their portal.
        </span>
        <textarea
          name="description"
          rows={2}
          defaultValue={task?.description ?? ""}
          className={field}
        />
      </label>

      <fieldset className="rounded-md border border-line-soft p-3">
        <legend className="px-1 text-[12px] font-medium text-dim">
          Who it applies to
        </legend>
        <div className="space-y-2">
          {(
            [
              ["all", "All accepted speakers"],
              ["track", "Everyone in one track"],
              ["persona", "Everyone with one role"],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="flex items-center gap-2 text-[13px]">
              <input
                type="radio"
                name="scope"
                value={value}
                defaultChecked={scope === value}
                className="h-4 w-4"
              />
              {text}
            </label>
          ))}

          <div className="grid gap-3 pl-6 sm:grid-cols-2">
            <select
              name="trackId"
              defaultValue={scope === "track" ? applies.slice(6) : ""}
              className={field}
              aria-label="Track"
            >
              <option value="">Choose a track</option>
              {trackList.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              name="personaId"
              defaultValue={scope === "persona" ? applies.slice(8) : ""}
              className={field}
              aria-label="Role"
            >
              <option value="">Choose a role</option>
              {personaList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] font-medium">Due date</span>
          <span className="block text-[12px] text-dim">
            End of that day, in the event's timezone.
          </span>
          <input
            type="date"
            name="dueAt"
            defaultValue={task?.dueInput ?? ""}
            className={field}
          />
        </label>
        <label className="mt-6 flex items-center gap-2">
          <input
            type="checkbox"
            name="required"
            defaultChecked={task?.required ?? true}
            className="h-4 w-4 rounded border-line-strong"
          />
          <span className="text-[13px]">
            Required
            <span className="block text-[12px] text-dim">
              Only required tasks count towards a speaker's progress.
            </span>
          </span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          {busy ? "Saving" : isEdit ? "Save task" : "Create task and assign it"}
        </button>
        <Link to="/admin/tasks" className="cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]">
          Cancel
        </Link>
      </div>
    </Form>
  );
}

export default function Tasks() {
  const { zone, editId, creating, tasks, trackList, personaList, ms } =
    useLoaderData<typeof loader>();
  const action = useActionData<{ error?: string; saved?: string }>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [params] = useSearchParams();

  const editing = tasks.find((t) => t.id === editId);
  const editHref = (id: string) => {
    const n = new URLSearchParams(params);
    n.set("edit", id);
    n.delete("new");
    return `?${n}`;
  };

  return (
    <div>
      <div className="border-b border-line bg-surface px-6 py-5">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Tasks</h1>
            <p className="mt-0.5 text-[13px] text-dim">
              What every accepted speaker has to do before the event. Chasing
              happens on{" "}
              <Link
                to="/admin/onboarding"
                className="text-accent-text underline underline-offset-2"
              >
                Onboarding
              </Link>
              .
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="?new=1"
              className="cb-btn cb-btn-primary px-2.5 py-1.5 text-[13px]"
            >
              New task
            </Link>
            <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim" title="Time spent in this page's loader fetching data. It excludes rendering, so it is not total server time: that is in the Server-Timing response header.">
              data {ms} ms
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl space-y-4 px-6 py-4">
        {action?.error && (
          <p className="cb-note cb-note-danger px-3 py-2.5 text-[13px]">
            {action.error}
          </p>
        )}
        {action?.saved && (
          <p className="cb-note cb-note-success px-3 py-2.5 text-[13px]">
            {action.saved}
          </p>
        )}

        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {tasks.length === 0 ? (
            <p className="px-6 py-12 text-center text-[13px] text-dim">
              No tasks yet. Speakers will have nothing to do and the onboarding
              board will be empty.
            </p>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="cb-thead text-[11px] uppercase tracking-[0.06em]">
                  <th className="w-10 px-2 py-2 font-medium"></th>
                  <th className="px-4 py-2 font-medium">Task</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 font-medium">Applies to</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                  <th className="px-4 py-2 font-medium">Completed</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => {
                  const pct = t.assigned
                    ? Math.round((t.done / t.assigned) * 100)
                    : 0;
                  const unassigned = t.audience - t.assigned;
                  return (
                    <tr
                      key={t.id}
                      className="cb-row-hover border-b border-line-soft last:border-0"
                    >
                      <td className="px-2 py-2.5 align-middle">
                        <div className="flex flex-col">
                          <Form method="post">
                            <input type="hidden" name="intent" value="move" />
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="dir" value="-1" />
                            <button
                              disabled={i === 0 || busy}
                              title="Move up"
                              className="px-1 text-[10px] leading-none text-faint hover:text-strong disabled:opacity-30"
                            >
                              ▲
                            </button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="move" />
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="dir" value="1" />
                            <button
                              disabled={i === tasks.length - 1 || busy}
                              title="Move down"
                              className="px-1 text-[10px] leading-none text-faint hover:text-strong disabled:opacity-30"
                            >
                              ▼
                            </button>
                          </Form>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-strong">{t.name}</div>
                        {t.description && (
                          <div className="text-[12px] text-dim">
                            {t.description}
                          </div>
                        )}
                        {!t.required && (
                          <span className="cb-pill cb-pill-neutral">optional</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {kindLabel(t.kind)}
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {t.appliesToLabel}
                        {unassigned > 0 && (
                          <Form method="post" className="mt-1">
                            <input type="hidden" name="intent" value="resync" />
                            <input type="hidden" name="id" value={t.id} />
                            <button
                              disabled={busy}
                              className="text-[12px] text-warn underline-offset-2 hover:underline"
                              title="Speakers have been accepted since this task was made"
                            >
                              {unassigned} not yet assigned, fix
                            </button>
                          </Form>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-dim">
                        {t.dueAt
                          ? fmtDateIn(t.dueAt, zone, {
                              day: "numeric",
                              month: "short",
                            })
                          : "No date"}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div
                              className={[
                                "h-full rounded-full",
                                pct === 100 ? "bg-success-solid" : "bg-accent-solid",
                              ].join(" ")}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-dim">
                            {t.done}/{t.assigned}
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <Link
                          to={editHref(t.id)}
                          className="text-[12px] text-accent-text underline-offset-2 hover:underline"
                        >
                          Edit
                        </Link>
                        <Form method="post" className="ml-2 inline">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={t.id} />
                          <button
                            disabled={busy}
                            onClick={(e) => {
                              const done = t.done;
                              const who =
                                t.assigned === 1 ? "that speaker" : "all of them";
                              const record = done
                                ? `, including the record that ${done} of them already did it`
                                : "";
                              const msg =
                                t.assigned === 0
                                  ? `Delete "${t.name}"? Nobody is assigned to it.`
                                  : `"${t.name}" is assigned to ${t.assigned} speaker${t.assigned === 1 ? "" : "s"}` +
                                    (done
                                      ? `, and ${done} of them have already completed it.`
                                      : ".") +
                                    `\n\nDeleting removes it from ${who}${record}.\n\nDelete anyway?`;
                              if (!confirm(msg)) e.preventDefault();
                            }}
                            className="text-[12px] text-danger underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </Form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {(creating || editing) && (
          <TaskEditor
            key={editing?.id ?? "new"}
            task={editing}
            trackList={trackList}
            personaList={personaList}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}
