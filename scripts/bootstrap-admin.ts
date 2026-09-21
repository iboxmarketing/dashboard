#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { hashPassword } from "../lib/auth/password";
import { bootstrapAdmin, type Target } from "./bootstrap-admin-lib";

/**
 * First-administrator bootstrap CLI. All decisions live in
 * bootstrap-admin-lib.ts; this file only reads arguments and the terminal.
 *
 *   npm run auth:bootstrap-admin -- --target staging \
 *     --config /abs/staging.wrangler.jsonc --binding DB \
 *     --database-name bitrix-dashboard-staging --database-id <uuid> \
 *     --email admin@example.com --name "Admin Name" [--env <name>]
 */

function valueAfter(args: string[], name: string) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function required(args: string[], name: string) { const value = valueAfter(args, name); if (!value) throw new Error(`${name} is required`); return value; }

/** Hidden TTY input: the password is never echoed, logged or passed on argv. */
async function readSecret(prompt: string) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Bootstrap requires an interactive TTY for the temporary password");
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
        value += String.fromCharCode(byte); process.stderr.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}

const args = process.argv.slice(2);
const configPath = resolve(required(args, "--config"));
const result = await bootstrapAdmin({
  target: required(args, "--target") as Target,
  configPath,
  config: readFileSync(configPath, "utf8"),
  binding: required(args, "--binding"),
  databaseName: required(args, "--database-name"),
  databaseId: required(args, "--database-id"),
  env: valueAfter(args, "--env"),
  email: required(args, "--email"),
  name: required(args, "--name"),
  confirmProduction: args.includes("--confirm-production"),
}, {
  hashPassword,
  readSecret,
  runWrangler: (wranglerArgs) => {
    const run = spawnSync("npx", ["--no-install", "wrangler", ...wranglerArgs], {
      cwd: process.cwd(), encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", WRANGLER_LOG_PATH: resolve(tmpdir(), `auth-bootstrap-${process.pid}.log`) },
    });
    return { status: run.status, stdout: run.stdout };
  },
});
console.log(JSON.stringify(result));
