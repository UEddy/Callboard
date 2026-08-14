import { createContext, type RouterContextProvider } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export const cloudflareContext = createContext<{
  env: Env;
  ctx: ExecutionContext;
}>();

/* For code that runs outside the router and so has no context: the
   worker's own fetch handler, which gates /admin before any route is
   matched. */
export function dbFromEnv(env: Env) {
  return drizzle(env.DB, { schema });
}

export function getDb(context: RouterContextProvider) {
  const { env } = context.get(cloudflareContext);
  return dbFromEnv(env);
}

export type Db = ReturnType<typeof getDb>;
export const DEMO_EVENT_ID = "evt_aiewf26";