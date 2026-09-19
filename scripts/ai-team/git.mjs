import path from "node:path";
import { access, lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { runCommand, safeEnvironment } from "./process.mjs";

const gitEnv = safeEnvironment({ GIT_TERMINAL_PROMPT: "0" });
const INSTRUCTION_FILES = [
  "AGENTS.md", "CLAUDE.md", "docs/HANDOFF.md", "docs/BUSINESS_RULES.md",
  "docs/ARCHITECTURE.md", "docs/OPERATIONS.md",
];
const DEFAULT_CONTEXT_BYTES = 600_000;
const FORBIDDEN_CONTEXT_PARTS = new Set([
  ".git", ".ai-team", ".vscode", ".wrangler", ".codex", ".claude",
  ".ssh", ".aws", ".kube", ".docker", ".gcloud", "node_modules",
]);

function forbiddenContextPath(file) {
  const parts = file.replaceAll("\\", "/").split("/");
  const base = parts.at(-1)?.toLowerCase() ?? "";
  return parts.some((part) => FORBIDDEN_CONTEXT_PARTS.has(part.toLowerCase()))
    || base === ".npmrc" || base === ".netrc"
    || base === ".dev.vars" || base.startsWith(".dev.vars.")
    || base === ".env" || base.startsWith(".env.")
    || /^id_(?:rsa|ed25519)/.test(base)
    || /\.(?:p12|pfx|kdbx|sqlite3?|db)$/i.test(base);
}

export async function git(cwd, args, options = {}) {
  return await runCommand("git", args, { cwd, env: gitEnv, timeoutMs: options.timeoutMs ?? 120_000, input: options.input });
}

export async function assertClean(repo) {
  const result = await git(repo, ["status", "--porcelain=v1"]);
  if (result.stdout.trim()) throw new Error("Repository must be clean before an orchestration run.");
}

export async function resolveRef(repo, ref) {
  return (await git(repo, ["rev-parse", "--verify", ref])).stdout.trim();
}

export function safeBranchPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "run";
}

export async function addWorktree(repo, worktreePath, branch, startPoint) {
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, worktreePath, startPoint]);
  const dependencies = path.join(repo, "node_modules");
  try {
    await access(dependencies, constants.R_OK);
    await symlink(dependencies, path.join(worktreePath, "node_modules"), "dir");
  } catch { /* A fixture or fresh checkout may intentionally have no install yet. */ }
}

export async function changedFiles(worktree) {
  const result = await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  return result.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)).map((entry) => entry.includes(" -> ") ? entry.split(" -> ").at(-1) : entry);
}

function globRegex(glob) {
  let expression = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") { expression += ".*"; index += 1; }
    else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.\\+^$(){}|[\]]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

export function pathOwned(file, patterns) {
  return patterns.some((pattern) => globRegex(pattern).test(file));
}

export async function taskFileContext(worktree, ownedPaths, { maxBytes = DEFAULT_CONTEXT_BYTES } = {}) {
  const tracked = (await git(worktree, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
  const changed = await changedFiles(worktree);
  const candidates = [...new Set([
    ...INSTRUCTION_FILES.filter((file) => tracked.includes(file)),
    ...tracked.filter((file) => pathOwned(file, ownedPaths)),
    ...changed.filter((file) => pathOwned(file, ownedPaths)),
  ])].sort();
  const root = await realpath(worktree);
  const files = [];
  let bytes = 0;
  for (const file of candidates) {
    if (forbiddenContextPath(file)) throw new Error(`Task context refuses a sensitive path: ${file}`);
    const absolute = path.resolve(root, file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Task context path escapes the worktree: ${file}`);
    }
    let info;
    try { info = await lstat(absolute); } catch { continue; }
    if (!info.isFile()) throw new Error(`Task context accepts regular files only: ${file}`);
    const content = await readFile(absolute, "utf8");
    if (content.includes("\0")) throw new Error(`Task context cannot include a binary file: ${file}`);
    bytes += Buffer.byteLength(file) + Buffer.byteLength(content);
    if (bytes > maxBytes) {
      throw new Error(`Task context exceeds ${maxBytes} bytes; split the task into smaller owned paths.`);
    }
    files.push({ path: file, content });
  }
  return JSON.stringify({ files });
}

export async function validateTaskChanges(worktree, task) {
  const files = await changedFiles(worktree);
  if (!files.length) throw new Error(`Task ${task.id} produced no changed files.`);
  const forbidden = files.filter((file) => file === ".vscode" || file.startsWith(".vscode/"));
  if (forbidden.length) throw new Error(`Task ${task.id} modified forbidden files: ${forbidden.join(", ")}`);
  const outside = files.filter((file) => !pathOwned(file, task.ownedPaths));
  if (outside.length) throw new Error(`Task ${task.id} changed files outside ownership: ${outside.join(", ")}`);
  for (const file of files) {
    const absolute = path.join(worktree, file);
    let content;
    try { content = await readFile(absolute, "utf8"); } catch { continue; }
    if (/https?:\/\/[^\s"'<>]+\/rest\/\d+\/[A-Za-z0-9_-]{8,}\/?/i.test(content)) {
      throw new Error(`Task ${task.id} appears to contain a Bitrix credential in ${file}.`);
    }
  }
  return files;
}

export async function commitTask(worktree, task, files) {
  await git(worktree, ["add", "--", ...files]);
  await git(worktree, [
    "-c", "user.name=IBOX AI Team", "-c", "user.email=ai-team@localhost",
    "commit", "-m", `ai-team(${task.agent}): ${task.title}`,
  ]);
  return (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function cherryPick(worktree, commit) {
  await git(worktree, [
    "-c", "user.name=IBOX AI Team", "-c", "user.email=ai-team@localhost",
    "cherry-pick", commit,
  ]);
}

export async function diffFiles(worktree, baseRef) {
  const result = await git(worktree, ["diff", "--name-only", `${baseRef}...HEAD`]);
  return result.stdout.trim().split("\n").filter(Boolean);
}
