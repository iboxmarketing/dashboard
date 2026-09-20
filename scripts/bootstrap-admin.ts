#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { hashPassword, validatePassword } from "../lib/auth/password";
import { normalizeEmail } from "../lib/auth/types";

type Target = "staging" | "production";
function valueAfter(args: string[], name: string) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function fail(message: string): never { throw new Error(message); }
function sqlText(value: string) { return `'${value.replaceAll("'", "''")}'`; }

async function readSecret(prompt: string) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) fail("Bootstrap requires an interactive TTY for the temporary password");
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise<string>((resolveSecret, reject) => {
    const finish = (error?: Error) => {
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData); process.stderr.write("\n");
      if (error) reject(error); else resolveSecret(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("Bootstrap cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) { if (value) { value = value.slice(0, -1); process.stderr.write("\b \b"); } continue; }
        const character = String.fromCharCode(byte); value += character; process.stderr.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}

const args = process.argv.slice(2);
const configPath = resolve(valueAfter(args, "--config") ?? fail("--config is required"));
const database = valueAfter(args, "--database") ?? fail("--database is required");
const target = valueAfter(args, "--target") as Target | undefined;
const email = normalizeEmail(valueAfter(args, "--email"));
const name = String(valueAfter(args, "--name") ?? "").trim();
if (target !== "staging" && target !== "production") fail("--target must be staging or production");
if (target === "production" && !args.includes("--confirm-production")) fail("Production bootstrap requires --confirm-production");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail("--email is invalid");
if (name.length < 2 || name.length > 120) fail("--name must be 2–120 characters");

const configText = readFileSync(configPath, "utf8");
const configuredWorker = /"name"\s*:\s*"([^"]+)"/.exec(configText)?.[1] ?? "";
const configuredDatabase = /"database_name"\s*:\s*"([^"]+)"/.exec(configText)?.[1] ?? "";
if (configuredDatabase !== database) fail("--database does not match the config DB binding");
if (target === "staging" && (!configuredDatabase.toLowerCase().includes("staging") || !configuredWorker.toLowerCase().includes("staging"))) fail("Config Worker and D1 must both be explicitly staging");
if (target === "production" && (configuredDatabase.toLowerCase().includes("staging") || configuredWorker.toLowerCase().includes("staging"))) fail("Production bootstrap refuses a staging config");

const password = await readSecret("Temporary password: ");
const confirmation = await readSecret("Repeat temporary password: ");
if (password !== confirmation) fail("Passwords do not match");
const checked = validatePassword(password);
if (!checked.ok) fail(checked.error);
const passwordHash = await hashPassword(checked.value);
const id = crypto.randomUUID();
const now = new Date().toISOString();
const sql = `INSERT INTO app_users (id,email,name,role,password_hash,must_change_password,active,created_at,updated_at,last_login_at)
SELECT ${sqlText(id)},${sqlText(email)},${sqlText(name)},'ADMIN',${sqlText(passwordHash)},1,1,${sqlText(now)},${sqlText(now)},NULL
WHERE NOT EXISTS (SELECT 1 FROM app_users); SELECT changes() AS created;`;
const run = spawnSync("npx", ["--no-install", "wrangler", "d1", "execute", "DB", "--remote", "--config", configPath, "--yes", "--command", sql], {
  cwd: process.cwd(), encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1", WRANGLER_LOG_PATH: resolve(tmpdir(), `auth-bootstrap-${process.pid}.log`) },
});
if (run.status !== 0) fail(`Wrangler D1 command failed with exit ${run.status ?? "unknown"}`);
const created = /"created"\s*:\s*1/u.test(run.stdout);
if (!created) fail("Bootstrap refused: app_users already contains a user");
console.log(JSON.stringify({ target, database, created: true, userId: id, email, mustChangePassword: true }));
