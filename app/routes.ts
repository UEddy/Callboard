import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("submit/:slug", "routes/submit.$slug.tsx"),
  route("portal", "routes/portal.tsx"),
  route("api/v1/*", "routes/api.tsx"),
  route("files/*", "routes/files.$.tsx"),
  route("theme", "routes/theme.tsx"),
  route("e/:eventSlug", "routes/e.$eventSlug.tsx"),
  // Before the catch-all view segment, so /sessions/SESS-4 is a session
  // rather than a view called "sessions" with a stray path.
  route("e/:eventSlug/calendar.ics", "routes/e.$eventSlug.calendar.tsx"),
  route("e/:eventSlug/sessions/:ref", "routes/e.$eventSlug.sessions.$ref.tsx"),
  route("e/:eventSlug/speakers/:id", "routes/e.$eventSlug.speakers.$id.tsx"),
  route("e/:eventSlug/:view", "routes/e.$eventSlug.$view.tsx"),
  // Outside the admin layout on purpose: the one page under /admin an
  // unauthenticated request may reach.
  route("admin/sign-in", "routes/admin.sign-in.tsx"),
  route("admin", "routes/admin.tsx", [
    index("routes/admin._index.tsx"),
    route("submissions", "routes/admin.submissions.tsx"),
    route("submissions/:id", "routes/admin.submissions.$id.tsx"),
    route("abstracts", "routes/admin.abstracts.tsx"),
    route("sessions", "routes/admin.sessions.tsx"),
    route("decisions", "routes/admin.decisions.tsx"),
    route("evaluation", "routes/admin.evaluation.tsx"),
    route("onboarding", "routes/admin.onboarding.tsx"),
    route("forms", "routes/admin.forms.tsx"),
    route("library", "routes/admin.library.tsx"),
    route("tasks", "routes/admin.tasks.tsx"),
    route("people", "routes/admin.people.tsx"),
    route("people/:id", "routes/admin.people.$id.tsx"),
    route("emails", "routes/admin.emails.tsx"),
    route("emails/:id", "routes/admin.emails.$id.tsx"),
    route("forms/:formId", "routes/admin.forms.$formId.tsx"),
    route("agenda", "routes/admin.agenda.tsx"),
    route("integrations", "routes/admin.integrations.tsx"),
    route("embeds", "routes/admin.embeds.tsx"),
    route("settings", "routes/admin.settings.tsx"),
    route("export", "routes/admin.export.tsx"),
  ]),
] satisfies RouteConfig;