import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("submit/:slug", "routes/submit.$slug.tsx"),
  route("portal", "routes/portal.tsx"),
  route("admin", "routes/admin.tsx", [
    route("submissions", "routes/admin.submissions.tsx"),
    route("decisions", "routes/admin.decisions.tsx"),
    route("evaluation", "routes/admin.evaluation.tsx"),
    route("onboarding", "routes/admin.onboarding.tsx"),
    route("forms", "routes/admin.forms.tsx"),
    route("forms/:formId", "routes/admin.forms.$formId.tsx"),
    route("agenda", "routes/admin.agenda.tsx"),
  ]),
] satisfies RouteConfig;