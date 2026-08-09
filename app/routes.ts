import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("admin", "routes/admin.tsx", [
    route("submissions", "routes/admin.submissions.tsx"),
  ]),
] satisfies RouteConfig;