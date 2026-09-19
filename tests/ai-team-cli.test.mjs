import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts/ai-team/cli.mjs");
const capabilities = {
  codex: ["--sandbox", "--output-schema", "--output-last-message", "--ephemeral"],
  claude: ["--print", "--json-schema", "--permission-mode", "--permission-prompts", "--no-session-persistence", "--restricted"],
};

async function fixture(t, omitted) {
  const repo = await mkdtemp(path.join(tmpdir(), "ai-team-cli-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const commands = {};
  for (const [agent, flags] of Object.entries(capabilities)) {
    const command = path.join(repo, `${agent}.mjs`);
    const helpArgs = agent === "codex" ? ["exec", "--help"] : ["--help"];
    const help = flags.filter((flag) => `${agent} ${flag}` !== omitted).join("\n");
    await writeFile(command, `#!${process.execPath}
const args = JSON.stringify(process.argv.slice(2));
if (args === '["--version"]') console.log(${JSON.stringify(`${agent} fixture 1.0`)});
else if (args === ${JSON.stringify(JSON.stringify(helpArgs))}) console.log(${JSON.stringify(help)});
else { console.error('Unexpected mock arguments'); process.exitCode = 2; }
`);
    await chmod(command, 0o755);
    commands[agent] = command;
  }
  return { repo, commands };
}

function run(f, args, npm = false) {
  return spawnSync(npm ? "npm" : process.execPath, npm ? ["run", "ai-team", "--", ...args] : [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: f.repo,
      LANG: "C",
      npm_config_cache: path.join(f.repo, "npm-cache"),
      npm_config_userconfig: path.join(f.repo, "absent-npmrc"),
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
}

function doctorArgs(f) {
  return ["doctor", "--repo", f.repo, "--codex-command", f.commands.codex, "--claude-command", f.commands.claude];
}

function succeeded(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}

for (const npm of [false, true]) {
  const entry = npm ? "npm run ai-team --" : "direct CLI";
  test(`${entry} help documents inline goals and goal files on separate usage lines`, async (t) => {
    const f = await fixture(t);
    const result = run(f, ["help"], npm);
    succeeded(result);
    assert.match(result.stdout, /^  npm run ai-team -- run --goal "[^"\n]+"[^\n]*$/m);
    assert.match(result.stdout, /^  npm run ai-team -- run --goal-file path\/to\/goal\.md[^\n]*$/m);
  });

  test(`${entry} doctor accepts every required capability and reports mock versions`, async (t) => {
    const f = await fixture(t);
    const result = run(f, doctorArgs(f), npm);
    succeeded(result);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    assert.deepEqual(report, {
      codex: "codex fixture 1.0",
      claude: "claude fixture 1.0",
      supported: capabilities,
    });
  });
}

for (const [agent, flags] of Object.entries(capabilities)) {
  for (const flag of flags) {
    test(`doctor rejects ${agent} when required capability ${flag} is missing`, async (t) => {
      const f = await fixture(t, `${agent} ${flag}`);
      const result = run(f, doctorArgs(f));
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const identifier = `${agent === "codex" ? "codex exec" : "claude"} ${flag}`;
      assert.equal(result.stderr, `ai-team: Installed CLIs lack required safe noninteractive flags: ${identifier}\n`);
    });
  }
}
