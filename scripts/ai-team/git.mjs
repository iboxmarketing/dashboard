import path from "node:path";
import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { runCommand, safeEnvironment } from "./process.mjs";

const gitEnv = safeEnvironment({ GIT_TERMINAL_PROMPT: "0" });

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
  await git(worktree, ["cherry-pick", commit]);
}

export async function diffFiles(worktree, baseRef) {
  const result = await git(worktree, ["diff", "--name-only", `${baseRef}...HEAD`]);
  return result.stdout.trim().split("\n").filter(Boolean);
}
