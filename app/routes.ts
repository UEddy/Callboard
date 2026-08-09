import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("admin", "routes/admin.tsx", [
    route("submissions", "routes/admin.submissions.tsx"),
    route("onboarding", "routes/admin.onboarding.tsx"),
    route("forms", "routes/admin.forms.tsx"),
    route("forms/:formId", "routes/admin.forms.$formId.tsx"),
  ]),
] satisfies RouteConfig;