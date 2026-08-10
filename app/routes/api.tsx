import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { and, eq, inArray, asc, sql } from "drizzle-orm";
import { getDb, cloudflareContext } from "~/db/client";
import { applyRoutingRules, type RoutingEffect } from "~/lib/routing";
import { sendSubmissionConfirmation } from "~/lib/notify";
import {
  events,
  submissions,
  submissionParticipants,
  participants,
  tracks,
  rooms,
  forms,
  formFields,
  fieldDefinitions,
} from "~/db/schema";

/* ------------------------------------------------------------------ *
 * JSON API.
 *
 * Read endpoints are public: this is the same data a conference puts on
 * its own website, and making it open means an embed, a mobile app, or
 * a sponsor's microsite can all read it without a key dance.
 * Write endpoints need a bearer token (API_KEY secret).
 * ------------------------------------------------------------------ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, init: ResponseInit = {}, cacheSeconds = 0) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...(cacheSeconds
        ? { "Cache-Control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` }
        : { "Cache-Control": "no-store" }),
      ...(init.headers ?? {}),
    },
  });
}

function fail(status: number, message: string, detail?: unknown) {
  return json({ error: { status, message, detail } }, { status });
}

function authorized(request: Request, env: Env) {
  const key = (env as unknown as { API_KEY?: string }).API_KEY;
  if (!key) return false;
  const header = request.headers.get("Authorization") ?? "";
  return header === `Bearer ${key}`;
}

const EVENT_UTC_OFFSET = -7;

/* The only status an unauthenticated caller may read. Everything else is
   either not yet decided or was rejected, and neither is anyone's
   business but the organiser's. */
const PUBLIC_STATUS = "accepted";

const STATUSES = [
  "draft",
  "submitted",
  "pending",
  "accept_queue",
  "accepted",
  "decline_queue",
  "declined",
  "withdrawn",
];

function localParts(ms: number) {
  const d = new Date(ms + EVENT_UTC_OFFSET * 3_600_000);
  return {
    date: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16),
  };
}

/* --- Shared shapes ------------------------------------------------- */

async function loadSessions(
  db: ReturnType<typeof getDb>,
  eventId: string,
  filters: { track?: string; format?: string; status?: string } = {},
) {
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
      endsAt: submissions.endsAt,
      trackName: tracks.name,
      trackColor: tracks.color,
      roomName: rooms.name,
    })
    .from(submissions)
    .leftJoin(tracks, eq(submissions.trackId, tracks.id))
    .leftJoin(rooms, eq(submissions.roomId, rooms.id))
    .where(
      and(
        eq(submissions.eventId, eventId),
        eq(submissions.status, filters.status ?? "accepted"),
        filters.track ? eq(tracks.name, filters.track) : undefined,
        filters.format ? eq(submissions.format, filters.format) : undefined,
      ),
    )
    .orderBy(asc(submissions.startsAt));

  const ids = rows.map((r) => r.id);
  const people = ids.length
    ? await db
        .select({
          submissionId: submissionParticipants.submissionId,
          id: participants.id,
          firstName: participants.firstName,
          lastName: participants.lastName,
          company: participants.company,
          jobTitle: participants.jobTitle,
          bio: participants.bio,
          headshotUrl: participants.headshotUrl,
          links: participants.links,
          role: submissionParticipants.role,
        })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          eq(submissionParticipants.participantId, participants.id),
        )
        .where(inArray(submissionParticipants.submissionId, ids))
    : [];

  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    title: r.title,
    description: r.description,
    status: r.status,
    format: r.format,
    level: r.level,
    track: r.trackName
      ? { name: r.trackName, color: r.trackColor }
      : null,
    room: r.roomName,
    startsAt: r.startsAt ? new Date(r.startsAt).toISOString() : null,
    endsAt: r.endsAt ? new Date(r.endsAt).toISOString() : null,
    speakers: people
      .filter((p) => p.submissionId === r.id)
      .map((p) => ({
        id: p.id,
        name: [p.firstName, p.lastName].filter(Boolean).join(" "),
        company: p.company,
        jobTitle: p.jobTitle,
        role: p.role,
        headshotUrl: p.headshotUrl,
        links: p.links ?? {},
      })),
  }));
}

/* --- Router -------------------------------------------------------- */

async function handle(
  request: Request,
  context: Parameters<typeof getDb>[0],
) {
  const db = getDb(context);
  const env = context.get(cloudflareContext).env;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // GET /api/v1
  if (parts.length === 0) {
    return json(
      {
        name: "Callboard API",
        version: "1",
        endpoints: [
          "GET  /api/v1/events",
          "GET  /api/v1/events/:slug",
          "GET  /api/v1/events/:slug/sessions?track=&format=   (accepted only)",
          "GET  /api/v1/events/:slug/sessions?status=pending   (bearer token)",
          "GET  /api/v1/events/:slug/speakers",
          "GET  /api/v1/events/:slug/agenda",
          "GET  /api/v1/events/:slug/forms",
          "GET  /api/v1/events/:slug/forms/:formSlug",
          "POST /api/v1/events/:slug/forms/:formSlug/submissions   (bearer token)",
          "PATCH /api/v1/submissions/:id                            (bearer token)",
        ],
        notes:
          "Public reads return accepted sessions only and are cached for 60 seconds. Reading any other status, and every write, needs Authorization: Bearer <API_KEY>.",
      },
      {},
      300,
    );
  }

  /* --- PATCH /submissions/:id ------------------------------------- */
  if (parts[0] === "submissions" && parts[1]) {
    if (method !== "PATCH") return fail(405, "Use PATCH on this endpoint.");
    if (!authorized(request, env))
      return fail(401, "Missing or invalid bearer token.");

    const body = (await request.json().catch(() => null)) as {
      status?: string;
      title?: string;
      trackId?: string;
    } | null;
    if (!body) return fail(400, "Body must be JSON.");

    if (body.status && !STATUSES.includes(body.status))
      return fail(422, `status must be one of: ${STATUSES.join(", ")}`);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status) patch.status = body.status;
    if (body.title) patch.title = body.title;
    if (body.trackId) patch.trackId = body.trackId;

    await db.update(submissions).set(patch).where(eq(submissions.id, parts[1]));
    const row = await db.query.submissions.findFirst({
      where: eq(submissions.id, parts[1]),
    });
    if (!row) return fail(404, "Submission not found.");
    return json({ data: { id: row.id, ref: row.ref, status: row.status } });
  }

  if (parts[0] !== "events") return fail(404, "Unknown endpoint.");

  /* --- GET /events ------------------------------------------------- */
  if (parts.length === 1) {
    if (method !== "GET") return fail(405, "Use GET on this endpoint.");
    const rows = await db
      .select({
        slug: events.slug,
        name: events.name,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        timezone: events.timezone,
      })
      .from(events);
    return json(
      {
        data: rows.map((e) => ({
          ...e,
          startsAt: e.startsAt ? new Date(e.startsAt).toISOString() : null,
          endsAt: e.endsAt ? new Date(e.endsAt).toISOString() : null,
        })),
      },
      {},
      60,
    );
  }

  const slug = parts[1];
  const event = await db.query.events.findFirst({ where: eq(events.slug, slug) });
  if (!event) return fail(404, `No event with slug "${slug}".`);

  const sub = parts[2];

  /* --- GET /events/:slug ------------------------------------------- */
  if (!sub) {
    const counts = await db
      .select({ status: submissions.status, n: sql<number>`count(*)` })
      .from(submissions)
      .where(eq(submissions.eventId, event.id))
      .groupBy(submissions.status);

    return json(
      {
        data: {
          slug: event.slug,
          name: event.name,
          description: event.description,
          startsAt: event.startsAt ? new Date(event.startsAt).toISOString() : null,
          endsAt: event.endsAt ? new Date(event.endsAt).toISOString() : null,
          timezone: event.timezone,
          submissionCounts: Object.fromEntries(
            counts.map((c) => [c.status, Number(c.n)]),
          ),
        },
      },
      {},
      60,
    );
  }

  /* --- GET /events/:slug/sessions ---------------------------------- */
  if (sub === "sessions") {
    /* status is caller supplied, so it decides whether this response is
       public data or the organiser's private pipeline. Anything other
       than accepted needs the bearer token, and the answer must not be
       cached by anything shared. */
    const requested = url.searchParams.get("status");
    let status: string | undefined;

    if (requested !== null && requested !== PUBLIC_STATUS) {
      if (!authorized(request, env)) {
        return fail(
          401,
          `Only "${PUBLIC_STATUS}" sessions are public.`,
          "Pass Authorization: Bearer <API_KEY> to read submissions in any other status.",
        );
      }
      if (!STATUSES.includes(requested)) {
        return fail(422, `status must be one of: ${STATUSES.join(", ")}`);
      }
      status = requested;
    }

    const privileged = status !== undefined;

    const data = await loadSessions(db, event.id, {
      track: url.searchParams.get("track") ?? undefined,
      format: url.searchParams.get("format") ?? undefined,
      status,
    });

    return json({ data, count: data.length }, {}, privileged ? 0 : 60);
  }

  /* --- GET /events/:slug/speakers ---------------------------------- */
  if (sub === "speakers") {
    const sessions = await loadSessions(db, event.id);
    const seen = new Map<string, Record<string, unknown>>();
    for (const s of sessions) {
      for (const sp of s.speakers) {
        const existing = seen.get(sp.id);
        if (existing) {
          (existing.sessions as unknown[]).push({ ref: s.ref, title: s.title });
        } else {
          seen.set(sp.id, {
            ...sp,
            sessions: [{ ref: s.ref, title: s.title }],
          });
        }
      }
    }
    const data = [...seen.values()];
    return json({ data, count: data.length }, {}, 60);
  }

  /* --- GET /events/:slug/agenda ------------------------------------ */
  if (sub === "agenda") {
    const sessions = await loadSessions(db, event.id);
    const byDay = new Map<string, unknown[]>();
    for (const s of sessions) {
      if (!s.startsAt) continue;
      const { date, time } = localParts(new Date(s.startsAt).getTime());
      const arr = byDay.get(date) ?? [];
      arr.push({ ...s, localTime: time });
      byDay.set(date, arr);
    }
    const roomList = await db
      .select({ name: rooms.name, capacity: rooms.capacity })
      .from(rooms)
      .where(eq(rooms.eventId, event.id))
      .orderBy(rooms.sortOrder);

    return json(
      {
        data: {
          timezone: event.timezone,
          rooms: roomList,
          days: [...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, sessions]) => ({ date, sessions })),
          unscheduled: sessions.filter((s) => !s.startsAt).length,
        },
      },
      {},
      60,
    );
  }

  /* --- Forms ------------------------------------------------------- */
  if (sub === "forms") {
    const formSlug = parts[3];

    if (!formSlug) {
      const rows = await db
        .select({
          slug: forms.publicSlug,
          name: forms.name,
          kind: forms.kind,
          status: forms.status,
          closeAt: forms.closeAt,
          submissionLimit: forms.submissionLimit,
        })
        .from(forms)
        .where(eq(forms.eventId, event.id));
      return json(
        {
          data: rows.map((f) => ({
            ...f,
            closeAt: f.closeAt ? new Date(f.closeAt).toISOString() : null,
            submitUrl: `/submit/${f.slug}`,
          })),
        },
        {},
        60,
      );
    }

    const form = await db.query.forms.findFirst({
      where: eq(forms.publicSlug, formSlug),
    });
    if (!form) return fail(404, `No form with slug "${formSlug}".`);

    /* --- POST /events/:slug/forms/:formSlug/submissions ------------ */
    if (parts[4] === "submissions") {
      if (method !== "POST") return fail(405, "Use POST on this endpoint.");
      if (!authorized(request, env))
        return fail(401, "Missing or invalid bearer token.");

      const body = (await request.json().catch(() => null)) as {
        title?: string;
        description?: string;
        format?: string;
        level?: string;
        trackId?: string;
        answers?: Record<string, unknown>;
        speaker?: {
          email?: string;
          firstName?: string;
          lastName?: string;
          company?: string;
        };
      } | null;

      if (!body?.title) return fail(422, "title is required.");
      if (!body.speaker?.email) return fail(422, "speaker.email is required.");

      const closed =
        form.status !== "open" ||
        (form.closeAt ? new Date(form.closeAt).getTime() < Date.now() : false);
      if (closed) return fail(409, "This form is not accepting submissions.");

      let person = await db.query.participants.findFirst({
        where: and(
          eq(participants.eventId, event.id),
          eq(participants.email, body.speaker.email.toLowerCase()),
        ),
      });
      if (!person) {
        const pid = crypto.randomUUID();
        await db.insert(participants).values({
          id: pid,
          eventId: event.id,
          email: body.speaker.email.toLowerCase(),
          firstName: body.speaker.firstName ?? null,
          lastName: body.speaker.lastName ?? null,
          company: body.speaker.company ?? null,
        });
        person = { id: pid } as never;
      }

      const seqRow = await db
        .select({ max: sql<number>`coalesce(max(${submissions.refSeq}), 0)` })
        .from(submissions)
        .where(eq(submissions.eventId, event.id));
      const seq = Number(seqRow[0]?.max ?? 0) + 1;
      const id = crypto.randomUUID();

      await db.insert(submissions).values({
        id,
        eventId: event.id,
        formId: form.id,
        ref: `${form.kind === "abstracts" ? "ABS" : "SESS"}-${seq}`,
        refSeq: seq,
        kind: form.kind,
        title: body.title,
        description: body.description ?? null,
        format: body.format ?? null,
        level: body.level ?? null,
        trackId: body.trackId ?? null,
        answers: body.answers ?? {},
        status: "pending",
        submittedAt: new Date(),
      });

      await db.insert(submissionParticipants).values({
        submissionId: id,
        participantId: (person as { id: string }).id,
        role: "Speaker",
        isPrimary: true,
        sortOrder: 0,
      });

      // Same rules as the public form, so an API submission lands in the
      // same track with the same reviewers as one typed into the browser.
      let routing: RoutingEffect[] = [];
      try {
        routing = await applyRoutingRules(db, {
          eventId: event.id,
          formId: form.id,
          submissionId: id,
        });
      } catch (e) {
        console.error("routing failed for", id, e);
      }

      // And the same acknowledgement, so a speaker cannot tell whether
      // the organiser typed their proposal in or posted it.
      const confirmation = await sendSubmissionConfirmation(db, env, {
        submissionId: id,
        participantId: (person as { id: string }).id,
        origin: new URL(request.url).origin,
      });

      return json(
        {
          data: {
            id,
            ref: `${form.kind === "abstracts" ? "ABS" : "SESS"}-${seq}`,
            status: "pending",
            routing: routing.map((r) => ({
              rule: r.ruleId,
              matched: r.condition,
              track: r.setTrack,
              tags: r.addedTags,
              evaluationPlan: r.plan,
              reviewersAssigned: r.reviewers,
            })),
            confirmationEmail: confirmation.sent
              ? { sent: true, simulated: confirmation.simulated }
              : { sent: false, reason: confirmation.reason },
          },
        },
        { status: 201 },
      );
    }

    const fields = await db
      .select({
        key: fieldDefinitions.key,
        label: fieldDefinitions.label,
        type: fieldDefinitions.type,
        options: fieldDefinitions.options,
        helpText: fieldDefinitions.helpText,
        required: formFields.required,
        step: formFields.step,
        sortOrder: formFields.sortOrder,
        conditionalRule: formFields.conditionalRule,
      })
      .from(formFields)
      .innerJoin(
        fieldDefinitions,
        eq(formFields.fieldDefinitionId, fieldDefinitions.id),
      )
      .where(eq(formFields.formId, form.id))
      .orderBy(asc(formFields.sortOrder));

    return json(
      {
        data: {
          slug: form.publicSlug,
          name: form.name,
          kind: form.kind,
          status: form.status,
          closeAt: form.closeAt ? new Date(form.closeAt).toISOString() : null,
          submissionLimit: form.submissionLimit,
          allowMultipleDrafts: form.allowMultipleDrafts,
          fields,
        },
      },
      {},
      60,
    );
  }

  return fail(404, "Unknown endpoint.");
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  return handle(request, context);
}

export async function action({ request, context }: ActionFunctionArgs) {
  return handle(request, context);
}
