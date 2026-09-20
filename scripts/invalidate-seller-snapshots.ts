#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  parseSellerSnapshotRepairManifest,
  sellerSnapshotInvalidationSql,
  sellerSnapshotRepairPreviewSql,
} from "../lib/seller-snapshot-repair";

type Target = "staging" | "production";

function valueAfter(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseWranglerResult(output: string) {
  const match = output.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
  if (!match) return fail("Wrangler returned an unreadable result");
  return JSON.parse(match[1]) as { results?: Record<string, unknown>[]; meta?: { changes?: number } }[];
}

function runD1(config: string, sql: string) {
  const run = spawnSync("npx", [
    "--no-install", "wrangler", "d1", "execute", "DB", "--remote",
    "--config", config, "--yes", "--command", sql,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      WRANGLER_LOG_PATH: resolve(tmpdir(), `seller-snapshot-repair-${process.pid}.log`),
    },
  });
  if (run.status !== 0) fail(`Wrangler D1 command failed with exit ${run.status ?? "unknown"}`);
  return parseWranglerResult(run.stdout);
}

function preview(config: string, dealIds: string[]) {
  const result = runD1(config, sellerSnapshotRepairPreviewSql(dealIds));
  const row = result[0]?.results?.[0] ?? {};
  return { matched: Number(row.matched ?? 0), wouldChange: Number(row.would_change ?? 0) };
}

const args = process.argv.slice(2);
const manifestPath = valueAfter(args, "--manifest") ?? fail("--manifest is required");
const configPath = resolve(valueAfter(args, "--config") ?? fail("--config is required"));
const database = valueAfter(args, "--database") ?? fail("--database is required");
const target = valueAfter(args, "--target") as Target | undefined;
if (target !== "staging" && target !== "production") fail("--target must be staging or production");
const apply = args.includes("--apply");
if (args.includes("--dry-run") && apply) fail("Choose either --dry-run or --apply");
if (target === "production" && apply && !args.includes("--confirm-production")) {
  fail("Production apply requires --confirm-production in addition to --apply");
}

const configText = readFileSync(configPath, "utf8");
const configuredWorker = /"name"\s*:\s*"([^"]+)"/.exec(configText)?.[1] ?? "";
const configuredDatabase = /"database_name"\s*:\s*"([^"]+)"/.exec(configText)?.[1] ?? "";
if (configuredDatabase !== database) fail("--database does not match the config DB binding");
if (!configuredDatabase.toLowerCase().includes(target) || !configuredWorker.toLowerCase().includes(target)) {
  fail(`Config Worker and D1 must both be explicitly ${target}`);
}

const manifest = parseSellerSnapshotRepairManifest(JSON.parse(readFileSync(resolve(manifestPath), "utf8")));
const before = preview(configPath, manifest.dealIds);
const base = {
  target,
  database,
  requested: manifest.dealIds.length,
  matched: before.matched,
  missing: manifest.dealIds.length - before.matched,
};

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", ...base, wouldChange: before.wouldChange, modified: 0 }));
  process.exit(0);
}

const applied = runD1(configPath, sellerSnapshotInvalidationSql(manifest.dealIds));
const modified = Number(applied[0]?.meta?.changes ?? 0);
const after = preview(configPath, manifest.dealIds);
if (after.wouldChange !== 0) fail("Repair verification failed: targeted seller rows remain attributed");
console.log(JSON.stringify({ mode: "apply", ...base, wouldChange: before.wouldChange, modified, remaining: after.wouldChange }));
