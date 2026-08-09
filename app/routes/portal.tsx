import { Form, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID } from "~/db/client";
import {
  participants,
  authTokens,
  submissions,
  submissionParticipants,
  tasks,
  taskAssignments,
  tracks,
  rooms,
  events,
} from "~/db/schema";
import { readPortal, writePortal } from "~/lib/session";

const EVENT_UTC_OFFSET = -7;

export async function loader({ context, request }: LoaderFunctionArgs) {
  const started = Date.now();
  const db = getDb(context);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  const event = await db.query.events.findFirst({
    where: eq(events.id, DEMO_EVENT_ID),
  });

  /* --- Magic link arrival: verify, burn the token, set the cookie --- */
  if (token) {
    const row = await db.query.authTokens.findFirst({
      where: eq(authTokens.token, token),
    });
    const valid =
      row && !row.usedAt && new Date(row.expiresAt).getTime() > Date.now();

    if (valid) {
      await db
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(eq(authTokens.id, row.id));
      return redirect("/portal", {
        headers: {
          "Set-Cookie": await writePortal({ participantId: row.participantId }),
        },
      });
    }
    return { state: "expired" as const, event, ms: Date.now() - started };
  }

  const session = await readPortal(request);
  if (!session.participantId) {
    return { state: "login" as const, event, ms: Date.now() - started };
  }

  const me = await db.query.participants.findFirst({
    where: eq(participants.id, session.participantId),
  });
  if (!me) {
    return { state: "login" as const, event, ms: Date.now() - started };
  }

  const mine = await db
    .select({
      id: submissions.id,
      ref: submissions.ref,
      title: submissions.title,
      status: submissions.status,
      format: submissions.format,
      startsAt: submissions.startsAt,
      trackName: tracks.name,
      roomName: rooms.name,
    })
    .from(submissions)
    .innerJoin(
      submissionParticipants,
      eq(submissionParticipants.submissionId, submissions.id),
    )
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(eq(submissionParticipants.participantId, me.id));

  const accepted = mine.filter((s) => s.status === "accepted");

  const taskList = accepted.length
    ? await db
        .select()
        .from(tasks)
        .where(eq(tasks.eventId, DEMO_EVENT_ID))
        .orderBy(tasks.sortOrder)
    : [];

  const assignments = await db
    .select()
    .from(taskAssignments)
    .where(eq(taskAssignments.participantId, me.id));

  const myTasks = taskList.map((t) => {
    const a = assignments.find((x) => x.taskId === t.id);
    const status = a?.status ?? "not_started";
    const due = t.dueAt ? new Date(t.dueAt).getTime() : null;
    const done = status === "complete" || status === "waived";
    return {
      taskId: t.id,
      assignmentId: a?.id ?? null,
      name: t.name,
      description: t.description,
      kind: t.kind,
      dueAt: due,
      required: t.required,
      status,
      done,
      overdue: !done && due !== null && due < Date.now(),
      fileUrl: a?.fileUrl ?? null,
    };
  });

  return {
    state: "in" as const,
    event,
    me,
    mine,
    accepted,
    myTasks,
    ms: Date.now() - started,
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent"));

  /* --- Request a magic link ---------------------------------------- */
  if (intent === "request_link") {
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    const person = await db.query.participants.findFirst({
      where: and(
        eq(participants.eventId, DEMO_EVENT_ID),
        eq(participants.email, email),
      ),
    });

    // Do not reveal whether the address is known. Same response either way.
    if (!person) return { sent: true, link: null };

    const token = crypto.randomUUID().replace(/-/g, "");
    await db.insert(authTokens).values({
      participantId: person.id,
      token,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });

    // Email delivery is wired separately. Until then the link is returned
    // so the flow is testable end to end.
    return { sent: true, link: `/portal?token=${token}` };
  }

  const session = await readPortal(request);
  if (!session.participantId) return redirect("/portal");

  if (intent === "sign_out") {
    return redirect("/portal", {
      headers: { "Set-Cookie": await writePortal({}) },
    });
  }

  if (intent === "save_profile") {
    await db
      .update(participants)
      .set({
        firstName: String(fd.get("firstName") ?? "") || null,
        lastName: String(fd.get("lastName") ?? "") || null,
        company: String(fd.get("company") ?? "") || null,
        jobTitle: String(fd.get("jobTitle") ?? "") || null,
        bio: String(fd.get("bio") ?? "") || null,
        headshotUrl: String(fd.get("headshotUrl") ?? "") || null,
        links: {
          linkedin: String(fd.get("linkedin") ?? ""),
          twitter: String(fd.get("twitter") ?? ""),
          website: String(fd.get("website") ?? ""),
        },
        updatedAt: new Date(),
      })
      .where(eq(participants.id, session.participantId));
    return { saved: true };
  }

  if (intent === "complete_task") {
    const taskId = String(fd.get("taskId"));
    const fileUrl = String(fd.get("fileUrl") ?? "") || null;
    const assignmentId = String(fd.get("assignmentId") ?? "");

    if (assignmentId) {
      await db
        .update(taskAssignments)
        .set({ status: "complete", completedAt: new Date(), fileUrl })
        .where(eq(taskAssignments.id, assignmentId));
    } else {
      await db.insert(taskAssignments).values({
        taskId,
        participantId: session.participantId,
        status: "complete",
        completedAt: new Date(),
        fileUrl,
      });
    }
    return { saved: true };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */

const input =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-[14px] outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100";

function fmtSession(ms: number | null) {
  if (!ms) return null;
  const d = new Date(ms + EVENT_UTC_OFFSET * 3_600_000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })} at ${hh}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} PT`;
}

const STATUS_COPY: Record<string, { text: string; cls: string }> = {
  accepted: {
    text: "Accepted",
    cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  },
  pending: {
    text: "Under review",
    cls: "bg-amber-50 text-amber-700 ring-amber-600/20",
  },
  accept_queue: {
    text: "Under review",
    cls: "bg-amber-50 text-amber-700 ring-amber-600/20",
  },
  decline_queue: {
    text: "Under review",
    cls: "bg-amber-50 text-amber-700 ring-amber-600/20",
  },
  declined: {
    text: "Not selected",
    cls: "bg-slate-100 text-slate-600 ring-slate-500/20",
  },
  draft: { text: "Draft", cls: "bg-slate-100 text-slate-600 ring-slate-500/20" },
  withdrawn: {
    text: "Withdrawn",
    cls: "bg-slate-100 text-slate-500 ring-slate-500/20",
  },
};

export default function Portal() {
  const data = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "home";

  const shell = (children: React.ReactNode, showTabs = false) => (
    <div className="min-h-screen bg-stone-100 px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <div className="text-[12px] font-medium uppercase tracking-[0.1em] text-slate-500">
              {data.event?.name}
            </div>
            <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-slate-900">
              Speaker portal
            </h1>
          </div>
          {data.state === "in" && (
            <Form method="post">
              <input type="hidden" name="intent" value="sign_out" />
              <button className="text-[13px] text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline">
                Sign out
              </button>
            </Form>
          )}
        </div>

        {showTabs && (
          <div className="mb-4 flex gap-1">
            {[
              ["home", "Home"],
              ["tasks", "Tasks"],
              ["profile", "Profile"],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.set("tab", k);
                  setParams(n);
                }}
                className={[
                  "rounded-lg px-3 py-1.5 text-[13px]",
                  tab === k
                    ? "bg-slate-900 font-medium text-white"
                    : "text-slate-600 hover:bg-slate-200",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {children}

        <div className="mt-4 flex justify-between text-[12px] text-slate-400">
          <span>Powered by Callboard</span>
          <span className="font-mono tabular-nums">{data.ms} ms</span>
        </div>
      </div>
    </div>
  );

  const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

  if (data.state === "login" || data.state === "expired") {
    return shell(
      <div className={card}>
        {data.state === "expired" && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            That link has expired or was already used. Request a new one.
          </p>
        )}
        <h2 className="text-[16px] font-semibold">Sign in</h2>
        <p className="mt-0.5 text-[13px] text-slate-500">
          We will email you a link. No password to remember.
        </p>
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="request_link" />
          <label className="block">
            <span className="text-[13px] font-medium">Email</span>
            <input
              name="email"
              type="email"
              required
              className={input}
              placeholder="you@company.com"
            />
          </label>
          <button
            disabled={busy}
            className="rounded-lg bg-slate-900 px-4 py-2 text-[14px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "Sending" : "Send me a link"}
          </button>
        </Form>
        <LinkResult />
      </div>,
    );
  }

  const { me, mine, accepted, myTasks } = data;
  const open = myTasks.filter((t) => !t.done);

  if (tab === "tasks") {
    return shell(
      <div className="space-y-3">
        {accepted.length === 0 ? (
          <div className={card}>
            <p className="text-[14px] font-medium">No tasks yet</p>
            <p className="mt-1 text-[13px] text-slate-500">
              Once a submission is accepted, everything we need from you shows up
              here.
            </p>
          </div>
        ) : (
          myTasks.map((t) => (
            <div key={t.taskId} className={card}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-slate-900">
                      {t.name}
                    </span>
                    {t.done ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                        Done
                      </span>
                    ) : t.overdue ? (
                      <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-700">
                        Overdue
                      </span>
                    ) : null}
                  </div>
                  {t.description && (
                    <p className="mt-0.5 text-[13px] text-slate-500">
                      {t.description}
                    </p>
                  )}
                  {t.dueAt && !t.done && (
                    <p className="mt-1 text-[12px] text-slate-500">
                      Due{" "}
                      {new Date(t.dueAt).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                      })}
                    </p>
                  )}
                </div>
              </div>

              {!t.done && (
                <Form method="post" className="mt-3 flex flex-wrap gap-2">
                  <input type="hidden" name="intent" value="complete_task" />
                  <input type="hidden" name="taskId" value={t.taskId} />
                  <input
                    type="hidden"
                    name="assignmentId"
                    value={t.assignmentId ?? ""}
                  />
                  {["upload_headshot", "upload_slides"].includes(t.kind) && (
                    <input
                      name="fileUrl"
                      type="url"
                      required
                      placeholder="Paste a link to your file"
                      className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-[13px]"
                    />
                  )}
                  <button
                    disabled={busy}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                  >
                    Mark done
                  </button>
                </Form>
              )}

              {t.done && t.fileUrl && (
                <a
                  href={t.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-[12px] text-indigo-700 underline underline-offset-2"
                >
                  View what you sent
                </a>
              )}
            </div>
          ))
        )}
      </div>,
      true,
    );
  }

  if (tab === "profile") {
    const links = (me.links ?? {}) as Record<string, string>;
    return shell(
      <Form method="post" className={`${card} space-y-4`}>
        <input type="hidden" name="intent" value="save_profile" />
        <div>
          <h2 className="text-[16px] font-semibold">Your details</h2>
          <p className="mt-0.5 text-[13px] text-slate-500">
            This is what appears on the website and what the host reads out
            before your session.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[13px] font-medium">First name</span>
            <input name="firstName" defaultValue={me.firstName ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Last name</span>
            <input name="lastName" defaultValue={me.lastName ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Company</span>
            <input name="company" defaultValue={me.company ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Job title</span>
            <input name="jobTitle" defaultValue={me.jobTitle ?? ""} className={input} />
          </label>
        </div>

        <label className="block">
          <span className="text-[13px] font-medium">Biography</span>
          <textarea
            name="bio"
            rows={6}
            defaultValue={me.bio ?? ""}
            className={input}
          />
        </label>

        <label className="block">
          <span className="text-[13px] font-medium">Headshot link</span>
          <input
            name="headshotUrl"
            type="url"
            defaultValue={me.headshotUrl ?? ""}
            placeholder="https://..."
            className={input}
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-[13px] font-medium">LinkedIn</span>
            <input name="linkedin" defaultValue={links.linkedin ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">X</span>
            <input name="twitter" defaultValue={links.twitter ?? ""} className={input} />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium">Website</span>
            <input name="website" defaultValue={links.website ?? ""} className={input} />
          </label>
        </div>

        <button
          disabled={busy}
          className="rounded-lg bg-slate-900 px-4 py-2 text-[14px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Saving" : "Save"}
        </button>
      </Form>,
      true,
    );
  }

  // Home
  return shell(
    <div className="space-y-4">
      {open.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="text-[14px] font-medium text-amber-900">
            {open.length} thing{open.length > 1 ? "s" : ""} still needed from you
          </div>
          <ul className="mt-1 space-y-0.5 text-[13px] text-amber-800">
            {open.slice(0, 3).map((t) => (
              <li key={t.taskId}>
                {t.name}
                {t.overdue && <span className="font-medium"> (overdue)</span>}
              </li>
            ))}
          </ul>
          <button
            onClick={() => {
              const n = new URLSearchParams(params);
              n.set("tab", "tasks");
              setParams(n);
            }}
            className="mt-2 rounded-lg bg-amber-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-amber-800"
          >
            Take care of it
          </button>
        </div>
      )}

      <div className={card}>
        <h2 className="text-[16px] font-semibold">Your submissions</h2>
        {mine.length === 0 ? (
          <p className="mt-2 text-[13px] text-slate-500">
            Nothing here yet.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {mine.map((s) => {
              const st = STATUS_COPY[s.status] ?? STATUS_COPY.pending;
              return (
                <div
                  key={s.id}
                  className="rounded-lg border border-slate-200 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-slate-400">
                      {s.ref}
                    </span>
                    <span className="text-[14px] font-medium text-slate-900">
                      {s.title || "Untitled"}
                    </span>
                    <span
                      className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${st.cls}`}
                    >
                      {st.text}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-500">
                    {[s.format, s.trackName].filter(Boolean).join(" · ")}
                  </div>
                  {s.status === "accepted" && (
                    <div className="mt-1.5 rounded-md bg-slate-50 px-2 py-1.5 text-[12px] text-slate-700">
                      {s.startsAt ? (
                        <>
                          {fmtSession(new Date(s.startsAt).getTime())}
                          {s.roomName ? ` in ${s.roomName}` : " (room to be confirmed)"}
                        </>
                      ) : (
                        "Scheduling is still being worked out. We will email you."
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    true,
  );
}

/* Shows the generated link until outbound email is wired up. */
function LinkResult() {
  const nav = useNavigation();
  if (nav.state !== "idle") return null;
  return (
    <p className="mt-4 text-[12px] text-slate-400">
      Check the response below the button after submitting.
    </p>
  );
}
