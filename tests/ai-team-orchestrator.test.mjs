import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentRunner, agentEnvironment, claudeInvocationArgs, codexInvocationArgs } from "../scripts/ai-team/agents.mjs";
import { pathOwned } from "../scripts/ai-team/git.mjs";
import { Orchestrator } from "../scripts/ai-team/orchestrator.mjs";
import { commandFailureMessage, redact, runCommand, safeEnvironment } from "../scripts/ai-team/process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mock = path.join(root, "tests/fixtures/mock-ai-cli.sh");

async function fixtureRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-team-test-"));
  await mkdir(path.join(repo, "docs"));
  await writeFile(path.join(repo, "AGENTS.md"), "Do not access external systems.\n");
  await writeFile(path.join(repo, "CLAUDE.md"), "Follow AGENTS.md.\n");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { verify: "node --test" } }));
  await writeFile(path.join(repo, "smoke.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture',()=>assert.equal(1,1));\n");
  await runCommand("git", ["init", "-b", "main"], { cwd: repo, env: safeEnvironment() });
  await runCommand("git", ["add", "."], { cwd: repo, env: safeEnvironment() });
  await runCommand("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"], { cwd: repo, env: safeEnvironment() });
  // Match a clean CI runner so integration commits cannot inherit a developer identity.
  await runCommand("git", ["config", "user.name", ""], { cwd: repo, env: safeEnvironment() });
  await runCommand("git", ["config", "user.email", ""], { cwd: repo, env: safeEnvironment() });
  return repo;
}

test("AI team completes planning, reciprocal reviews, integration, and verification with mock CLIs", async () => {
  await chmod(mock, 0o755);
  const repo = await fixtureRepo();
  const runner = new AgentRunner({ codexCommand: mock, claudeCommand: mock, timeoutMs: 20_000, mock: true });
  const orchestrator = new Orchestrator({ repo, runner, baseRef: "main", timeoutMs: 30_000 });
  const state = await orchestrator.run("Create two independent fixture documents.", { runId: "test-run" });
  assert.equal(state.status, "ready_for_owner");
  assert.equal(state.planApproval.approved, true);
  assert.deepEqual(state.tasks.map((item) => [item.task.agent, item.status]), [["codex", "complete"], ["claude", "complete"]]);
  assert.ok(state.tasks.every((item) => item.reviews.length === 1 && item.reviews[0].approved));
  assert.equal(state.tests.at(-1).command, "npm run verify");
  assert.equal(state.tests.at(-1).status, "passed");
  const integration = state.tasks[0].worktree.replace(/\/codex-doc$/, "/integration");
  assert.match(await readFile(path.join(integration, "docs/codex-fixture.md"), "utf8"), /codex fixture/);
  assert.match(await readFile(path.join(integration, "docs/claude-fixture.md"), "utf8"), /claude fixture/);
});

test("final Claude rejection blocks implementation before worktree creation", async () => {
  await chmod(mock, 0o755);
  const repo = await fixtureRepo();
  const delegate = new AgentRunner({ codexCommand: mock, claudeCommand: mock, timeoutMs: 20_000, mock: true });
  const runner = {
    async invoke(agent, options) {
      if (options.phase === "plan_approval") {
        return { approved: false, feedback: ["Acceptance criteria remain ambiguous."], unresolvedDecisions: [] };
      }
      return await delegate.invoke(agent, options);
    },
  };
  const orchestrator = new Orchestrator({ repo, runner, baseRef: "main", timeoutMs: 30_000 });
  const state = await orchestrator.run("Create two independent fixture documents.", { runId: "rejected-plan" });
  assert.equal(state.status, "needs_input");
  assert.equal(state.integrationBranch, null);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.planApproval.approved, false);
  assert.deepEqual(state.unresolved, ["Acceptance criteria remain ambiguous."]);
});

test("implementation invocations expose file editing but no command execution", () => {
  const codex = codexInvocationArgs({
    cwd: "/workspace", schemaPath: "/tmp/schema.json", outputPath: "/tmp/result.json", readOnly: false,
  });
  assert.ok(codex.some((item, index) => item === "--disable" && codex[index + 1] === "shell_tool"));
  assert.ok(codex.includes("--ignore-user-config"));
  assert.ok(codex.some((item, index) => item === "--config" && codex[index + 1] === 'approval_policy="never"'));
  assert.ok(codex.some((item, index) => item === "--config" && codex[index + 1] === 'web_search="disabled"'));
  assert.ok(!codex.some((item) => item.includes("dangerously-bypass")));

  const claude = claudeInvocationArgs({ schema: { type: "object" }, readOnly: false });
  const tools = claude[claude.indexOf("--tools") + 1];
  assert.equal(tools, "Read,Glob,Grep,Edit,Write");
  assert.equal(claude[claude.indexOf("--allowedTools") + 1], tools);
  assert.doesNotMatch(tools, /Bash|PowerShell|REPL/);
  assert.ok(claude.includes("--restricted"));
  assert.ok(claude.includes("--safe-mode"));
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.ok(!claude.some((item) => item.includes("dangerously-skip-permissions")));
});

test("agent launchers receive an isolated HOME and only their own auth directory", () => {
  const source = {
    PATH: "/usr/bin:/bin",
    HOME: "/real-home",
    CODEX_HOME: "/real-home/.codex",
    CLAUDE_CONFIG_DIR: "/real-home/.claude",
    BITRIX24_WEBHOOK_URL: "fixture-sensitive-value",
  };
  const codex = agentEnvironment("codex", "/tmp/codex-home", {}, source);
  assert.equal(codex.HOME, "/tmp/codex-home");
  assert.equal(codex.CODEX_HOME, "/real-home/.codex");
  assert.equal(codex.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(codex.BITRIX24_WEBHOOK_URL, undefined);
  const claude = agentEnvironment("claude", "/tmp/claude-home", {}, source);
  assert.equal(claude.HOME, "/tmp/claude-home");
  assert.equal(claude.CLAUDE_CONFIG_DIR, "/real-home/.claude");
  assert.equal(claude.CODEX_HOME, undefined);
  assert.equal(claude.BITRIX24_WEBHOOK_URL, undefined);
});

test("Claude retries malformed structured output once and returns the valid response", async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-team-claude-retry-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const command = path.join(repo, "claude-fixture.mjs");
  const counter = path.join(repo, "attempts");
  await writeFile(command, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const attempt = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(attempt));
process.stdout.write(attempt === 1
  ? '{"broken":'
  : '{"type":"assistant","message":{}}\\n{"type":"result","structured_output":{"ok":true,"note":"SOME_TOKEN: fixture-value"}}\\n');
`);
  await chmod(command, 0o755);
  const runner = new AgentRunner({ claudeCommand: command, timeoutMs: 20_000 });
  const result = await runner.invoke("claude", {
    cwd: repo,
    prompt: "Return the fixture result.",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "note"],
      properties: { ok: { type: "boolean" }, note: { type: "string" } },
    },
    readOnly: true,
    phase: "retry_test",
  });
  assert.deepEqual(result, { ok: true, note: "SOME_TOKEN: [REDACTED]" });
  assert.equal(await readFile(counter, "utf8"), "2");
});

test("path ownership supports exact files and bounded glob patterns", () => {
  assert.equal(pathOwned("docs/guide.md", ["docs/**"]), true);
  assert.equal(pathOwned("tests/unit/a.test.ts", ["tests/**/*.test.ts"]), true);
  assert.equal(pathOwned("lib/analytics.ts", ["docs/**"]), false);
});

test("subprocess environment excludes sensitive variables and output redacts credentials", () => {
  const previous = process.env.BITRIX24_WEBHOOK_URL;
  const credentialShape = `https://example.test/${["re", "st"].join("")}/123/abcdefghijk/`;
  process.env.BITRIX24_WEBHOOK_URL = "fixture-value";
  try {
    assert.equal(safeEnvironment().BITRIX24_WEBHOOK_URL, undefined);
    assert.equal(redact(credentialShape), "[REDACTED_BITRIX_URL]");
    assert.match(redact("Authorization: Bearer abcdef"), /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env.BITRIX24_WEBHOOK_URL;
    else process.env.BITRIX24_WEBHOOK_URL = previous;
  }
});

test("subprocess failure summaries do not copy agent prompts into run artifacts", () => {
  const message = commandFailureMessage("codex", {
    code: 1,
    timedOut: false,
    stdout: "",
    stderr: "generated implementation payload that must not be repeated\nERROR: You've hit your usage limit. Try again at 3:21 PM.\ntokens used 32,344\n",
  });
  assert.equal(message, "codex failed: local CLI usage limit reached; retry after 3:21 PM.");
  assert.doesNotMatch(message, /implementation payload/);
});

test("usage-limit retry hints reject arbitrary payload text", () => {
  const message = commandFailureMessage("codex", {
    code: 1,
    timedOut: false,
    stdout: "",
    stderr: `usage limit; try again at ${"customer-payload-".repeat(1_000)}`,
  });
  assert.equal(message, "codex failed: local CLI usage limit reached.");
  assert.doesNotMatch(message, /customer-payload/);
});

test("subprocess timeout summaries are explicit and bounded", () => {
  const message = commandFailureMessage("claude", {
    code: -1,
    timedOut: true,
    stdout: "",
    stderr: "x".repeat(10_000),
  });
  assert.equal(message, "claude failed: timed out.");
});

test("generic subprocess failures do not persist arbitrary stderr payloads", () => {
  const message = commandFailureMessage("git", {
    code: 17,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "customer payload with an unrecognized sensitive shape",
  });
  assert.equal(message, "git failed with exit code 17.");
});

test("authentication and signal subprocess summaries are classified without raw output", () => {
  assert.equal(commandFailureMessage("codex", {
    code: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "authentication required: arbitrary details",
  }), "codex failed: local CLI authentication is unavailable.");
  assert.equal(commandFailureMessage("claude", {
    code: -1,
    signal: "SIGTERM",
    timedOut: false,
    stdout: "",
    stderr: "arbitrary details",
  }), "claude failed after signal SIGTERM.");
});

test("runCommand keeps redacted process details off the thrown message", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.stderr.write('Authorization: Bearer abcdef'); process.exit(23)"]),
    (error) => {
      assert.equal(error.message, `${process.execPath} failed with exit code 23.`);
      assert.equal(error.result.code, 23);
      assert.equal(error.result.stderr, "Authorization: Bearer [REDACTED]");
      return true;
    },
  );
});
