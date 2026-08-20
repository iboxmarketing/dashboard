import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getD1() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("D1 DB binding mavjud emas");
  return binding;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

