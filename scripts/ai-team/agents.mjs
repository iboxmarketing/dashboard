import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

export function agentEnvironment(agent, isolatedHome, extra = {}, source = process.env) {
  const originalHome = source.HOME;
  const env = safeEnvironment({ HOME: isolatedHome, ...extra }, source);
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  if (agent === "codex") {
    const codexHome = source.CODEX_HOME ?? (originalHome ? path.join(originalHome, ".codex") : undefined);
    if (codexHome) env.CODEX_HOME = codexHome;
  } else if (agent === "claude") {
    const claudeConfig = source.CLAUDE_CONFIG_DIR ?? (originalHome ? path.join(originalHome, ".claude") : undefined);
    if (claudeConfig) env.CLAUDE_CONFIG_DIR = claudeConfig;
  } else {
    throw new Error(`Unknown agent: ${agent}`);
  }
  return env;
}

export function codexInvocationArgs({ cwd, schemaPath, outputPath, readOnly }) {
  const args = [
    "exec", "--ephemeral", "--ignore-user-config", "--strict-config", "--color", "never",
    "--sandbox", readOnly ? "read-only" : "workspace-write",
    "--config", 'approval_policy="never"',
    "--config", 'web_search="disabled"',
    "--config", 'shell_environment_policy.inherit="none"',
    "--disable", "apps", "--disable", "hooks", "--disable", "multi_agent",
  ];
  if (!readOnly) args.push("--disable", "shell_tool");
  args.push("--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", cwd, "-");
  return args;
}

export function claudeInvocationArgs({ schema, readOnly }) {
  const tools = readOnly ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write";
  return [
    "--print", "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--no-session-persistence", "--restricted", "--safe-mode", "--strict-mcp-config",
    "--disable-slash-commands", "--no-chrome", "--permission-prompts", "none",
    "--permission-mode", readOnly ? "plan" : "dontAsk", "--tools", tools,
  ];
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
    const isolatedHome = path.join(temp, "home");
    const schemaPath = path.join(temp, "schema.json");
    const outputPath = path.join(temp, "result.json");
    await mkdir(isolatedHome);
    await writeFile(schemaPath, JSON.stringify(schema));
    const args = codexInvocationArgs({ cwd, schemaPath, outputPath, readOnly });
    try {
      await runCommand(this.commands.codex, args, {
        cwd,
        input: prompt,
        timeoutMs: this.timeoutMs,
        env: agentEnvironment("codex", isolatedHome, {
          AI_TEAM_AGENT: "codex", AI_TEAM_PHASE: phase, AI_TEAM_MOCK: this.mock ? "1" : "0",
        }),
      });
      return JSON.parse(await readFile(outputPath, "utf8"));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async #claude({ cwd, prompt, schema, readOnly, phase }) {
    const temp = await mkdtemp(path.join(tmpdir(), "ibox-ai-team-claude-"));
    const isolatedHome = path.join(temp, "home");
    await mkdir(isolatedHome);
    const args = claudeInvocationArgs({ schema, readOnly });
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = await runCommand(this.commands.claude, args, {
          cwd,
          input: attempt === 1 ? prompt : `${prompt}\n\nYour previous response was not valid JSON. Preserve any allowed file edits already made and return only one object matching the requested schema.`,
          timeoutMs: this.timeoutMs,
          env: agentEnvironment("claude", isolatedHome, {
            AI_TEAM_AGENT: "claude", AI_TEAM_PHASE: phase, AI_TEAM_MOCK: this.mock ? "1" : "0",
          }),
        });
        try {
          return extractClaudeResult(result.stdout);
        } catch (error) {
          if (!(error instanceof SyntaxError) || attempt === 2) {
            throw new Error("Claude returned invalid structured output after one bounded retry.");
          }
        }
      }
      throw new Error("Claude returned no structured output.");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
