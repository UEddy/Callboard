import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { getDb, DEMO_EVENT_ID, cloudflareContext } from "~/db/client";
import { participants } from "~/db/schema";
import {
  INVOLVEMENT,
  SIGN_IN_LINK_TTL_HOURS,
  emailTaken,
  loadRoster,
  mintSignInLink,
  readPersonForm,
} from "~/lib/people";
import { Avatar, CopyLine } from "~/components/People";
import { publicBaseUrl } from "~/lib/base-url";

/* ------------------------------------------------------------------ *
 * Everyone attached to the event, in one list.
 *
 * The roster answers the questions that come up in the fortnight before
 * a show and nowhere else: who is this person, what are they down to do,
 * and have they sent me their headshot yet. Involvement is a filter
 * rather than a column because "show me who has done nothing" is the
 * query, and a column would make the producer scan for it.
 * ------------------------------------------------------------------ */

export async function loader({ context, request }: LoaderFunctionArgs) {
  const db = getDb(context);
  const roster = await loadRoster(db, request);
  const url = new URL(request.url);
  return {
    ...roster,
    creating: url.searchParams.get("new") === "1",
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const db = getDb(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  if (intent === "signin_link") {
    const personId = String(fd.get("participantId") ?? "");
    const person = await db.query.participants.findFirst({
      where: eq(participants.id, personId),
    });
    if (!person) return { error: "That person no longer exists." };

    const link = await mintSignInLink(
      db,
      personId,
      publicBaseUrl(context.get(cloudflareContext).env, request),
    );
    return {
      signInLink: link,
      signInFor:
        [person.firstName, person.lastName].filter(Boolean).join(" ") ||
        person.email,
    };
  }

  if (intent === "create") {
    const parsed = readPersonForm(fd);
    if (!parsed.ok) return { error: parsed.error };

    if (await emailTaken(db, parsed.email)) {
      return {
        error: `${parsed.email} is already on this event's roster. Open that person instead of making a second record.`,
      };
    }

    const id = crypto.randomUUID();
    await db.insert(participants).values({
      id,
      eventId: DEMO_EVENT_ID,
      ...parsed.values,
    });
    return redirect(`/admin/people/${id}?created=1`);
  }

  return { error: "Unknown action." };
}

/* --- UI --------------------------------------------------------------- */

const field =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong outline-none focus:border-accent-solid focus:ring-2 focus:ring-accent-ring";

export default function People() {
  const { rows, counts, total, q, involvement, creating, ms } =
    useLoaderData<typeof loader>();
  const action = useActionData<{
    error?: string;
    signInLink?: string;
    signInFor?: string;
  }>();
  const nav = useNavigation();
  const navigate = useNavigate();
  const busy = nav.state !== "idle";
  const [params] = useSearchParams();

  const filterHref = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("involvement", key);
    next.delete("new");
    return `/admin/people?${next}`;
  };

  return (
    <div>
      <div className="border-b border-line bg-surface">
        <div className="flex items-baseline justify-between px-6 pt-5">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">People</h1>
            <p className="mt-0.5 text-[13px] text-dim">
              Everyone on the event: speakers, co-presenters, evaluators and
              anyone you have added by hand.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="?new=1"
              className="cb-btn cb-btn-primary px-2.5 py-1.5 text-[13px]"
            >
              New person
            </Link>
            <div
              className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] tabular-nums text-dim"
              title="Server render time for this page"
            >
              {ms} ms
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-1 overflow-x-auto px-6">
          {INVOLVEMENT.map((i) => {
            const active = i.key === involvement;
            return (
              <Link
                key={i.key}
                to={filterHref(i.key)}
                prefetch="intent"
                className={[
                  "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors",
                  active
                    ? "border-accent-solid font-medium text-accent-text"
                    : "border-transparent text-dim hover:text-strong",
                ].join(" ")}
              >
                {i.label}
                <span
                  className={[
                    "rounded px-1.5 py-0.5 text-[11px] tabular-nums",
                    active
                      ? "bg-accent-soft-strong text-accent-text"
                      : "bg-muted text-dim",
                  ].join(" ")}
                >
                  {counts[i.key]}
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      <Form
        method="get"
        action="/admin/people"
        className="flex flex-wrap items-center gap-2 px-6 py-3"
      >
        <input type="hidden" name="involvement" value={involvement} />
        <input
          name="q"
          defaultValue={q}
          placeholder="Search name, email or company"
          className="w-72 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-strong outline-none placeholder:text-faint focus:border-accent-solid focus:ring-2 focus:ring-accent-ring"
        />
        <button type="submit" className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]">
          Search
        </button>
        {(q || involvement !== "all") && (
          <Link
            to="/admin/people"
            className="text-[13px] text-dim underline-offset-2 hover:text-strong hover:underline"
          >
            Clear
          </Link>
        )}
        <span className="ml-auto text-[12px] text-dim tabular-nums">
          {rows.length === total
            ? `${total} ${total === 1 ? "person" : "people"}`
            : `${rows.length} of ${total}`}
        </span>
      </Form>

      <div className="space-y-4 px-6 pb-8">
        {action?.error && (
          <p className="cb-note cb-note-danger px-3 py-2.5 text-[13px]">
            {action.error}
          </p>
        )}

        {action?.signInLink && (
          <div className="cb-note cb-note-accent px-3 py-2.5">
            <p className="text-[13px] font-medium">
              Sign-in link for {action.signInFor}
            </p>
            <p className="mb-2 text-[12px]">
              Works once, and expires in {SIGN_IN_LINK_TTL_HOURS} hours. Anyone
              holding it is signed in as that person, so send it to them
              directly and nowhere else.
            </p>
            <CopyLine text={action.signInLink} />
          </div>
        )}

        {creating && <PersonCreateForm busy={busy} />}

        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          {rows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[14px] font-medium text-strong">
                {total === 0 ? "Nobody here yet" : "Nobody matches that"}
              </p>
              <p className="mt-1 text-[13px] text-dim">
                {total === 0 ? (
                  <>
                    People arrive when somebody submits, or you can{" "}
                    <Link
                      to="?new=1"
                      className="text-accent-text underline underline-offset-2"
                    >
                      add one by hand
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    {total} {total === 1 ? "person is" : "people are"} on the
                    roster.{" "}
                    <Link
                      to="/admin/people"
                      className="text-accent-text underline underline-offset-2"
                    >
                      Clear the filters
                    </Link>
                    .
                  </>
                )}
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="cb-thead text-[11px] uppercase tracking-[0.06em]">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Company</th>
                  <th className="px-4 py-2 font-medium">Job title</th>
                  <th className="px-4 py-2 font-medium">Roles</th>
                  <th className="px-4 py-2 font-medium">Tasks</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const pct = p.tasksTotal
                    ? Math.round((p.tasksDone / p.tasksTotal) * 100)
                    : 0;
                  return (
                    <tr
                      key={p.id}
                      onClick={(e) => {
                        // Anything interactive in the row keeps its own
                        // behaviour; the rest of the row opens the person.
                        if (
                          (e.target as HTMLElement).closest(
                            "a,button,input,select,label",
                          )
                        )
                          return;
                        navigate(`/admin/people/${p.id}`);
                      }}
                      className="cb-row-hover cursor-pointer border-b border-line-soft last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <Avatar src={p.headshotUrl} name={p.name} />
                          <div className="min-w-0">
                            <Link
                              to={`/admin/people/${p.id}`}
                              prefetch="intent"
                              className="font-medium text-strong underline-offset-2 hover:underline"
                            >
                              {p.name}
                            </Link>
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              {p.isEvaluator && (
                                <span className="cb-pill cb-pill-accent">
                                  Evaluator
                                </span>
                              )}
                              {p.isAdmin && (
                                <span className="cb-pill cb-pill-neutral">
                                  Admin
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <a
                          href={`mailto:${p.email}`}
                          className="text-body underline-offset-2 hover:text-strong hover:underline"
                        >
                          {p.email}
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {p.company || <span className="text-faint">-</span>}
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {p.jobTitle || <span className="text-faint">-</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {p.roles.length === 0 ? (
                          <span className="text-faint">No submissions</span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1">
                            {p.roles.map((r) => (
                              <span key={r} className="cb-pill cb-pill-neutral">
                                {r}
                              </span>
                            ))}
                            <span
                              className="text-[12px] text-dim tabular-nums"
                              title={`${p.acceptedCount} accepted`}
                            >
                              {p.submissionCount}
                              {p.acceptedCount > 0 &&
                                ` · ${p.acceptedCount} accepted`}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {p.tasksTotal === 0 ? (
                          <span className="text-faint">None assigned</span>
                        ) : (
                          <div
                            className="flex items-center gap-2"
                            title="Every task assigned to this person, optional ones included"
                          >
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                              <div
                                className={[
                                  "h-full rounded-full",
                                  pct === 100
                                    ? "bg-success-solid"
                                    : "bg-accent-solid",
                                ].join(" ")}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-dim">
                              {p.tasksDone}/{p.tasksTotal}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="signin_link" />
                          <input
                            type="hidden"
                            name="participantId"
                            value={p.id}
                          />
                          <button
                            disabled={busy}
                            className="text-[12px] text-accent-text underline-offset-2 hover:underline disabled:opacity-50"
                            title="Mint a one-time link that signs this person into their portal"
                          >
                            Copy sign-in link
                          </button>
                        </Form>
                        <Link
                          to={`/admin/emails?compose=1&to=${p.id}`}
                          className="ml-3 text-[12px] text-dim underline-offset-2 hover:text-strong hover:underline"
                        >
                          Email
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function PersonCreateForm({ busy }: { busy: boolean }) {
  return (
    <Form
      method="post"
      className="space-y-3 rounded-lg border border-line bg-surface p-4"
    >
      <input type="hidden" name="intent" value="create" />
      <div>
        <h2 className="text-[14px] font-semibold">New person</h2>
        <p className="text-[12px] text-dim">
          For the people who never come through a form: a moderator you
          invited, an evaluator, a sponsor's speaker. The email is what
          everything else keys off, so it has to be the one they read.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-[13px] font-medium">Email</span>
          <input name="email" type="email" required className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">First name</span>
          <input name="firstName" className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Last name</span>
          <input name="lastName" className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Company</span>
          <input name="company" className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Job title</span>
          <input name="jobTitle" className={field} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Pronouns</span>
          <input name="pronouns" className={field} />
        </label>
      </div>

      <label className="block">
        <span className="text-[13px] font-medium">Bio</span>
        <textarea name="bio" rows={3} className={field} />
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="isEvaluator"
          className="h-4 w-4 rounded border-line-strong"
        />
        <span className="text-[13px]">
          Evaluator
          <span className="block text-[12px] text-dim">
            Can be assigned submissions to score on Evaluation.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          className="cb-btn cb-btn-primary px-3 py-1.5 text-[13px]"
        >
          {busy ? "Saving" : "Create person"}
        </button>
        <Link
          to="/admin/people"
          className="cb-btn cb-btn-secondary px-3 py-1.5 text-[13px]"
        >
          Cancel
        </Link>
      </div>
    </Form>
  );
}
