import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("submit/:slug", "routes/submit.$slug.tsx"),
  route("portal", "routes/portal.tsx"),
  route("api/v1/*", "routes/api.tsx"),
  route("files/*", "routes/files.$.tsx"),
  route("theme", "routes/theme.tsx"),
  route("e/:eventSlug", "routes/e.$eventSlug.tsx"),
  route("admin", "routes/admin.tsx", [
    index("routes/admin._index.tsx"),
    route("submissions", "routes/admin.submissions.tsx"),
    route("submissions/:id", "routes/admin.submissions.$id.tsx"),
    route("decisions", "routes/admin.decisions.tsx"),
    route("evaluation", "routes/admin.evaluation.tsx"),
    route("onboarding", "routes/admin.onboarding.tsx"),
    route("forms", "routes/admin.forms.tsx"),
    route("library", "routes/admin.library.tsx"),
    route("forms/:formId", "routes/admin.forms.$formId.tsx"),
    route("agenda", "routes/admin.agenda.tsx"),
    route("integrations", "routes/admin.integrations.tsx"),
    route("embeds", "routes/admin.embeds.tsx"),
    route("settings", "routes/admin.settings.tsx"),
  ]),
] satisfies RouteConfig;