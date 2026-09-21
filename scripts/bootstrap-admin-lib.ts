import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatePassword } from "../lib/auth/password";
import { normalizeEmail } from "../lib/auth/types";

/**
 * First-administrator bootstrap, as testable functions.
 *
 * The CLI (`scripts/bootstrap-admin.ts`) only reads the terminal and calls
 * `bootstrapAdmin`. Everything that decides whether and where to write lives
 * here, with Wrangler injected so tests can see every argument it would get.
 *
 * Target safety: the caller names the config, the binding, the database name
 * AND the database id, and all four must agree with exactly one D1 entry in the
 * parsed config. A binding that appears twice is ambiguous and refused.
 *
 * Secret handling: the password hash is never an argument. The INSERT is
 * written to a file created 0600 inside a fresh 0700 directory, passed to
 * Wrangler with `--file`, and removed in `finally` — success or failure.
 */

export type Target = "staging" | "production";
export type BootstrapOptions = {
  target: Target;
  configPath: string;
  config: string;
  binding: string;
  databaseName: string;
  databaseId: string;
  env?: string;
  email: string;
  name: string;
  confirmProduction?: boolean;
};
export type WranglerResult = { status: number | null; stdout: string };
export type BootstrapDeps = {
  runWrangler: (args: string[]) => WranglerResult;
  readSecret: (prompt: string) => Promise<string>;
  hashPassword: (password: string) => Promise<string>;
  randomId?: () => string;
  now?: () => Date;
  /** Where secret files are created; tests point this at a scratch dir. */
  tempRoot?: string;
};

/** JSONC → JSON: drops // and /* *\/ comments and trailing commas, never inside strings. */
export function stripJsonc(text: string) {
  let output = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (character === "\\") { output += next ?? ""; index += 1; }
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") { inString = true; output += character; continue; }
    if (character === "/" && next === "/") { while (index < text.length && text[index] !== "\n") index += 1; output += "\n"; continue; }
    if (character === "/" && next === "*") { index += 2; while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1; index += 1; continue; }
    output += character;
  }
  return output.replace(/,(\s*[}\]])/gu, "$1");
}

type D1Entry = { binding?: unknown; database_name?: unknown; database_id?: unknown };
type WranglerConfig = { name?: unknown; d1_databases?: D1Entry[]; env?: Record<string, { name?: unknown; d1_databases?: D1Entry[] }> };

/**
 * Finds the one D1 entry the caller means, or refuses.
 *
 * Exactly one entry must carry the binding, and its name and id must both
 * match what the caller typed — so a copy-pasted staging id against a
 * production config, or a config with the binding declared twice, stops here.
 */
export function resolveD1Target(configText: string, options: Pick<BootstrapOptions, "binding" | "databaseName" | "databaseId" | "env">) {
  let config: WranglerConfig;
  try { config = JSON.parse(stripJsonc(configText)) as WranglerConfig; }
  catch { throw new Error("Config could not be parsed as JSON/JSONC"); }
  const scope = options.env ? config.env?.[options.env] : config;
  if (!scope) throw new Error(`Config has no env "${options.env}"`);
  const entries = Array.isArray(scope.d1_databases) ? scope.d1_databases : [];
  const matches = entries.filter((entry) => entry.binding === options.binding);
  if (matches.length === 0) throw new Error(`Binding "${options.binding}" is not declared in this config`);
  if (matches.length > 1) throw new Error(`Binding "${options.binding}" is declared ${matches.length} times — ambiguous, refusing`);
  const [entry] = matches;
  if (entry.database_name !== options.databaseName) throw new Error("--database-name does not match the binding's database_name");
  if (typeof entry.database_id !== "string" || !entry.database_id) throw new Error("The binding has no database_id; refusing to guess the database");
  if (entry.database_id !== options.databaseId) throw new Error("--database-id does not match the binding's database_id");
  const workerName = String((options.env ? scope.name : undefined) ?? config.name ?? "");
  return { binding: options.binding, databaseName: entry.database_name as string, databaseId: entry.database_id, workerName };
}

export function assertTargetEnvironment(target: Target, workerName: string, databaseName: string, confirmProduction = false) {
  const staging = (value: string) => value.toLowerCase().includes("staging");
  if (target === "staging" && (!staging(databaseName) || !staging(workerName))) throw new Error("Config Worker and D1 must both be explicitly staging");
  if (target === "production") {
    if (!confirmProduction) throw new Error("Production bootstrap requires --confirm-production");
    if (staging(databaseName) || staging(workerName)) throw new Error("Production bootstrap refuses a staging config");
  }
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Inserts only into an empty table, so a second run can never add an admin. */
export function buildInsertSql(input: { id: string; email: string; name: string; passwordHash: string; now: string }) {
  return `INSERT INTO app_users (id,email,name,role,password_hash,must_change_password,active,created_at,updated_at,last_login_at)
SELECT ${sqlText(input.id)},${sqlText(input.email)},${sqlText(input.name)},'ADMIN',${sqlText(input.passwordHash)},1,1,${sqlText(input.now)},${sqlText(input.now)},NULL
WHERE NOT EXISTS (SELECT 1 FROM app_users);
`;
}

/**
 * Runs `consume` with a path to a file holding `content`, readable only by this
 * user, and deletes the file and its directory afterwards whatever happens.
 */
export async function withSecretFile<T>(content: string, consume: (path: string) => Promise<T> | T, tempRoot = tmpdir()): Promise<T> {
  const directory = mkdtempSync(join(tempRoot, "ibox-admin-"));
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, "bootstrap.sql");
    writeFileSync(path, content, { mode: 0o600, flag: "wx" });
    return await consume(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** First `results` array in `wrangler d1 execute --json` output. */
export function wranglerRows(stdout: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    for (const block of blocks) {
      const results = (block as { results?: unknown }).results;
      if (Array.isArray(results)) return results as Record<string, unknown>[];
    }
  } catch { /* handled by the caller as "unreadable" */ }
  throw new Error("Wrangler output could not be read");
}

export async function bootstrapAdmin(options: BootstrapOptions, deps: BootstrapDeps) {
  if (options.target !== "staging" && options.target !== "production") throw new Error("--target must be staging or production");
  const email = normalizeEmail(options.email);
  const name = options.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error("--email is invalid");
  if (name.length < 2 || name.length > 120) throw new Error("--name must be 2–120 characters");

  const target = resolveD1Target(options.config, options);
  assertTargetEnvironment(options.target, target.workerName, target.databaseName, options.confirmProduction);

  const base = ["d1", "execute", target.binding, "--remote", "--config", options.configPath, ...(options.env ? ["--env", options.env] : [])];
  const query = (sql: string) => {
    const run = deps.runWrangler([...base, "--json", "--command", sql]);
    if (run.status !== 0) throw new Error(`Wrangler D1 query failed with exit ${run.status ?? "unknown"}`);
    return wranglerRows(run.stdout);
  };

  // Refuse before a password is even asked for.
  const existing = Number(query("SELECT COUNT(*) AS users FROM app_users")[0]?.users ?? NaN);
  if (!Number.isFinite(existing)) throw new Error("Could not count existing users");
  if (existing > 0) throw new Error("Bootstrap refused: app_users already contains a user");

  const password = await deps.readSecret("Temporary password: ");
  const confirmation = await deps.readSecret("Repeat temporary password: ");
  if (password !== confirmation) throw new Error("Passwords do not match");
  const checked = validatePassword(password);
  if (!checked.ok) throw new Error(checked.error);
  const passwordHash = await deps.hashPassword(checked.value);
  const id = deps.randomId?.() ?? crypto.randomUUID();
  const now = (deps.now?.() ?? new Date()).toISOString();

  await withSecretFile(buildInsertSql({ id, email, name, passwordHash, now }), (file) => {
    const run = deps.runWrangler([...base, "--file", file, "--yes"]);
    if (run.status !== 0) throw new Error(`Wrangler D1 insert failed with exit ${run.status ?? "unknown"}`);
  }, deps.tempRoot);

  // The INSERT is guarded by NOT EXISTS; this read proves ours is the row.
  const created = query(`SELECT id FROM app_users WHERE id = ${sqlText(id)}`).length === 1;
  if (!created) throw new Error("Bootstrap refused: another user exists; nothing was created");
  return { target: options.target, database: target.databaseName, databaseId: target.databaseId, created: true, userId: id, email, mustChangePassword: true };
}
