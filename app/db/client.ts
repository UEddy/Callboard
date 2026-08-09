import { createContext, type RouterContextProvider } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export const cloudflareContext = createContext<{
  env: Env;
  ctx: ExecutionContext;
}>();

export function getDb(context: RouterContextProvider) {
  const { env } = context.get(cloudflareContext);
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;
export const DEMO_EVENT_ID = "evt_aiewf26";