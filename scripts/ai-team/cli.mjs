#!/usr/bin/env node
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "./agents.mjs";
import { commandVersion, runCommand, safeEnvironment } from "./process.mjs";
import { Orchestrator } from "./orchestrator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (["createPr", "keepWorktrees"].includes(key)) options[key] = true;
    else options[key] = rest[++index];
  }
  return options;
}

function usage() {
  return `IBOX AI Team Orchestrator\n\nUsage:\n  npm run ai-team -- doctor\n  npm run ai-team -- dry-run\n  npm run ai-team -- run --goal "Natural-language goal" [--base main] [--create-pr]\n  npm run ai-team -- run --goal-file path/to/goal.md [--base main]\n\nSafety defaults: isolated worktrees, no permission bypasses, no deploy/sync/backfill/D1 actions, bounded agents, two revision rounds, and no automatic merge to main.`;
}

async function goalFrom(options) {
  if (options.goal && options.goalFile) throw new Error("Use either --goal or --goal-file, not both.");
  if (options.goal) return options.goal.trim();
  if (options.goalFile) return (await readFile(path.resolve(options.goalFile), "utf8")).trim();
  throw new Error("A goal is required through --goal or --goal-file.");
}

async function doctor(repo, codexCommand = "codex", claudeCommand = "claude") {
  const [codex, claude, codexHelp, claudeHelp] = await Promise.all([
    commandVersion(codexCommand, ["--version"], repo),
    commandVersion(claudeCommand, ["--version"], repo),
    runCommand(codexCommand, ["exec", "--help"], { cwd: repo, timeoutMs: 20_000, maxOutput: 100_000 }),
    runCommand(claudeCommand, ["--help"], { cwd: repo, timeoutMs: 20_000, maxOutput: 100_000 }),
  ]);
  const checks = {
    codex: [
      "--sandbox", "--output-schema", "--output-last-message", "--ephemeral",
      "--config", "--disable", "--ignore-user-config", "--strict-config",
    ],
    claude: [
      "--print", "--json-schema", "--permission-mode", "--permission-prompts",
      "--no-session-persistence", "--restricted", "--tools", "--safe-mode",
      "--strict-mcp-config", "--disable-slash-commands", "--no-chrome",
    ],
  };
  const missing = [
    ...checks.codex.filter((flag) => !codexHelp.stdout.includes(flag)).map((flag) => `codex exec ${flag}`),
    ...checks.claude.filter((flag) => !claudeHelp.stdout.includes(flag)).map((flag) => `claude ${flag}`),
  ];
  if (missing.length) throw new Error(`Installed CLIs lack required safe noninteractive flags: ${missing.join(", ")}`);
  return { codex, claude, supported: checks };
}

async function createDryRunRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "ibox-ai-team-dry-run-"));
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(repo, "AGENTS.md"), "# Fixture rules\nDo not access external systems.\n");
  await writeFile(path.join(repo, "CLAUDE.md"), "Follow AGENTS.md.\n");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { verify: "node --test" } }, null, 2));
  await writeFile(path.join(repo, "smoke.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture',()=>assert.equal(1,1));\n");
  await runCommand("git", ["init", "-b", "main"], { cwd: repo, env: safeEnvironment() });
  await runCommand("git", ["add", "."], { cwd: repo, env: safeEnvironment() });
  await runCommand("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"], { cwd: repo, env: safeEnvironment() });
  return repo;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help" || options.command === "--help") return console.log(usage());
  const repo = path.resolve(options.repo ?? projectRoot);
  if (options.command === "doctor") return console.log(JSON.stringify(await doctor(repo, options.codexCommand, options.claudeCommand), null, 2));

  if (options.command === "dry-run") {
    const fixtureRepo = await createDryRunRepo();
    const mock = path.resolve(here, "../../tests/fixtures/mock-ai-cli.sh");
    await access(mock, constants.X_OK);
    const runner = new AgentRunner({ codexCommand: mock, claudeCommand: mock, timeoutMs: 30_000, mock: true });
    const orchestrator = new Orchestrator({ repo: fixtureRepo, runner, baseRef: "main", timeoutMs: 60_000 });
    const state = await orchestrator.run("Create two independent fixture documents, one owned by each agent.", { runId: "mock-dry-run" });
    console.log(JSON.stringify({ fixtureRepo, status: state.status, branch: state.integrationBranch, tasks: state.tasks.map((item) => item.status), tests: state.tests }, null, 2));
    if (state.status !== "ready_for_owner") process.exitCode = 1;
    return;
  }

  if (options.command !== "run") throw new Error(`Unknown command: ${options.command}`);
  const goal = await goalFrom(options);
  const health = await doctor(repo, options.codexCommand, options.claudeCommand);
  console.log(`Using ${health.codex} and ${health.claude}`);
  const runner = new AgentRunner({ codexCommand: options.codexCommand, claudeCommand: options.claudeCommand, timeoutMs: Number(options.timeoutMs ?? 900_000) });
  const orchestrator = new Orchestrator({ repo, runner, baseRef: options.base ?? "HEAD", timeoutMs: Number(options.timeoutMs ?? 900_000), keepWorktrees: options.keepWorktrees });
  const state = await orchestrator.run(goal, { runId: options.runId, createPr: options.createPr, pushRemote: options.remote ?? "origin" });
  console.log(JSON.stringify({ status: state.status, branch: state.integrationBranch, prUrl: state.prUrl, unresolved: state.unresolved }, null, 2));
  if (state.status !== "ready_for_owner") process.exitCode = 1;
}

main().catch((error) => {
  console.error(`ai-team: ${error.message}`);
  process.exitCode = 1;
});
