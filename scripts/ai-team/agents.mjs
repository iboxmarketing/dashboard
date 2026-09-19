import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand, safeEnvironment } from "./process.mjs";

function extractClaudeResult(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed.structured_output) return parsed.structured_output;
  if (parsed.result && typeof parsed.result === "string") {
    try { return JSON.parse(parsed.result); } catch { /* fall through */ }
  }
  return parsed;
}

export class AgentRunner {
  constructor({ codexCommand = "codex", claudeCommand = "claude", timeoutMs = 900_000, mock = false } = {}) {
    this.commands = { codex: codexCommand, claude: claudeCommand };
    this.timeoutMs = timeoutMs;
    this.mock = mock;
  }

  async invoke(agent, { cwd, prompt, schema, readOnly = false, phase }) {
    if (!this.commands[agent]) throw new Error(`Unknown agent: ${agent}`);
    return agent === "codex"
      ? await this.#codex({ cwd, prompt, schema, readOnly, phase })
      : await this.#claude({ cwd, prompt, schema, readOnly, phase });
  }

  async #codex({ cwd, prompt, schema, readOnly, phase }) {
    const temp = await mkdtemp(path.join(tmpdir(), "ibox-ai-team-codex-"));
    const schemaPath = path.join(temp, "schema.json");
    const outputPath = path.join(temp, "result.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const args = [
      "exec", "--ephemeral", "--color", "never", "--sandbox", readOnly ? "read-only" : "workspace-write",
      "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", cwd, "-",
    ];
    try {
      await runCommand(this.commands.codex, args, {
        cwd,
        input: prompt,
        timeoutMs: this.timeoutMs,
        env: safeEnvironment({ AI_TEAM_AGENT: "codex", AI_TEAM_PHASE: phase, AI_TEAM_MOCK: this.mock ? "1" : "0" }),
      });
      return JSON.parse(await readFile(outputPath, "utf8"));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async #claude({ cwd, prompt, schema, readOnly, phase }) {
    const args = [
      "--print", "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--no-session-persistence", "--restricted", "--permission-prompts", "none",
      "--permission-mode", readOnly ? "plan" : "dontAsk",
    ];
    if (readOnly) args.push("--tools", "Read,Glob,Grep");
    else args.push("--allowedTools", "Read,Glob,Grep,Edit,Write,Bash");
    const result = await runCommand(this.commands.claude, args, {
      cwd,
      input: prompt,
      timeoutMs: this.timeoutMs,
      env: safeEnvironment({ AI_TEAM_AGENT: "claude", AI_TEAM_PHASE: phase, AI_TEAM_MOCK: this.mock ? "1" : "0" }),
    });
    return extractClaudeResult(result.stdout);
  }
}
