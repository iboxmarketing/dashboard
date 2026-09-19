import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addWorktree, assertClean, changedFiles, cherryPick, commitTask, diffFiles, git,
  resolveRef, safeBranchPart, taskFileContext, validateTaskChanges,
} from "./git.mjs";
import { finalPlanApprovalPrompt, implementationPrompt, planningPrompt, planReviewPrompt, planRevisionPrompt, reviewPrompt, revisionPrompt } from "./prompts.mjs";
import { implementationSchema, planReviewSchema, planSchema, reviewSchema, revisionSchema } from "./schemas.mjs";
import { runCommand, safeEnvironment } from "./process.mjs";

const REVIEW_BLOCKERS = new Set(["critical", "high", "medium"]);

async function jsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function validatePlan(plan) {
  if (!plan.tasks.length) throw new Error("Plan must contain at least one implementation task.");
  const ids = new Set(plan.tasks.map((task) => task.id));
  if (ids.size !== plan.tasks.length) throw new Error("Plan contains duplicate task IDs.");
  for (const task of plan.tasks) {
    if (!task.ownedPaths.length) throw new Error(`Task ${task.id} has no owned paths.`);
    if (task.dependsOn.some((id) => !ids.has(id))) throw new Error(`Task ${task.id} has an unknown dependency.`);
    if (task.dependsOn.includes(task.id)) throw new Error(`Task ${task.id} depends on itself.`);
  }
  for (let left = 0; left < plan.tasks.length; left += 1) {
    for (let right = left + 1; right < plan.tasks.length; right += 1) {
      const prefix = (pattern) => pattern.split(/[?*]/, 1)[0].replace(/\/$/, "");
      const overlaps = plan.tasks[left].ownedPaths.some((a) => plan.tasks[right].ownedPaths.some((b) => {
        const leftPrefix = prefix(a); const rightPrefix = prefix(b);
        return a === b || a === "**" || b === "**"
          || (leftPrefix && rightPrefix && (leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`)));
      }));
      if (overlaps) throw new Error(`Tasks ${plan.tasks[left].id} and ${plan.tasks[right].id} have overlapping owned paths.`);
    }
  }
  const seen = new Set();
  while (seen.size < plan.tasks.length) {
    const ready = plan.tasks.filter((task) => !seen.has(task.id) && task.dependsOn.every((id) => seen.has(id)));
    if (!ready.length) throw new Error("Plan dependencies contain a cycle.");
    ready.forEach((task) => seen.add(task.id));
  }
  if (plan.tasks.length > 1 && new Set(plan.tasks.map((task) => task.agent)).size < 2) {
    throw new Error("A multi-task plan must assign implementation work to both Codex and Claude.");
  }
}

function consensusBlockers(plan, approval) {
  const blockers = [
    ...plan.unresolvedDecisions.filter((item) => item.blocking).map((item) => `${item.question}: ${item.reason}`),
    ...approval.unresolvedDecisions,
  ];
  if (!approval.approved) blockers.push(...(approval.feedback.length ? approval.feedback : ["Claude did not approve the revised plan."]));
  return blockers;
}

function safeTestCommand(command) {
  if (/[;&|><`$()\n\r]/.test(command)) return false;
  return /^(npm test|npm run (?:test|lint|typecheck|verify|secrets:check|build))(?:\s+--\s+[A-Za-z0-9_./*=-]+)*$/.test(command)
    || /^node --(?:import\s+tsx\s+)?test(?:\s+[A-Za-z0-9_./*=-]+)+$/.test(command);
}

async function runSafeTest(cwd, command, timeoutMs) {
  if (!safeTestCommand(command)) throw new Error(`Rejected unapproved test command: ${command}`);
  const isolatedHome = await mkdtemp(path.join(tmpdir(), "ibox-ai-team-test-home-"));
  const env = safeEnvironment({ HOME: isolatedHome, GIT_TERMINAL_PROMPT: "0" });
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  try {
    return await runCommand("bash", ["-c", command], { cwd, timeoutMs, env });
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

function markdownReport(state) {
  const taskLines = state.tasks.map((item) => `- ${item.task.id} — ${item.status}: ${item.implementation?.summary ?? item.error ?? ""}`);
  const contributionLines = ["codex", "claude"].map((agent) => {
    const tasks = state.tasks.filter((item) => item.task.agent === agent).map((item) => item.task.id);
    return `- ${agent}: ${tasks.length ? tasks.join(", ") : "planning/review only"}`;
  });
  const reviewLines = state.tasks.flatMap((item) => item.reviews.map((review, index) =>
    `- ${item.task.id}, round ${index + 1}: ${review.approved ? "approved" : `${review.findings.length} finding(s)`}`));
  return `# IBOX AI team run\n\n## Original goal\n\n${state.goal}\n\n## Plan consensus\n\n- Final Claude approval: ${state.planApproval.approved ? "approved" : "rejected"}\n\n## Tasks\n\n${taskLines.join("\n") || "- None"}\n\n## Contributions\n\n${contributionLines.join("\n")}\n\n## Tests\n\n${state.tests.map((item) => `- ${item.command}: ${item.status}`).join("\n") || "- Not run"}\n\n## Reviews\n\n${reviewLines.join("\n") || "- No task reviews"}\n\n## Changed files\n\n${state.changedFiles.map((file) => `- ${file}`).join("\n") || "- None"}\n\n## Risks and unresolved decisions\n\n${state.unresolved.map((item) => `- ${item}`).join("\n") || "- None"}\n\n## Branch / PR\n\n- Branch: ${state.integrationBranch ?? "not created"}\n- PR: ${state.prUrl ?? "not created"}\n\n## Owner acceptance\n\n1. Review this report and the agreed plan artifact.\n2. Review the integration branch diff.\n3. Confirm all unresolved decisions are acceptable.\n4. Confirm the recorded verification result.\n5. Open or approve the PR; merge manually only after approval.\n`;
}

export class Orchestrator {
  constructor({ repo, runner, baseRef = "HEAD", runRoot, worktreeRoot, timeoutMs = 900_000, keepWorktrees = true }) {
    this.repo = path.resolve(repo);
    this.runner = runner;
    this.baseRef = baseRef;
    this.runRoot = runRoot;
    this.worktreeRoot = worktreeRoot;
    this.timeoutMs = timeoutMs;
    this.keepWorktrees = keepWorktrees;
  }

  async run(goal, { runId, createPr = false, pushRemote = "origin" } = {}) {
    await assertClean(this.repo);
    const id = safeBranchPart(runId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
    const artifactDir = path.resolve(this.runRoot ?? path.join(this.repo, ".ai-team", "runs"), id);
    const workRoot = path.resolve(this.worktreeRoot ?? path.join(this.repo, ".ai-team", "worktrees"), id);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "goal.txt"), `${goal.trim()}\n`);
    const baseSha = await resolveRef(this.repo, this.baseRef);

    const initial = await this.runner.invoke("codex", {
      cwd: this.repo, prompt: planningPrompt(goal), schema: planSchema, readOnly: true, phase: "plan",
    });
    await jsonFile(path.join(artifactDir, "plan.codex.json"), initial);
    const planReview = await this.runner.invoke("claude", {
      cwd: this.repo, prompt: planReviewPrompt(goal, initial), schema: planReviewSchema, readOnly: true, phase: "plan_review",
    });
    await jsonFile(path.join(artifactDir, "plan.claude-review.json"), planReview);
    const plan = await this.runner.invoke("codex", {
      cwd: this.repo, prompt: planRevisionPrompt(goal, initial, planReview), schema: planSchema, readOnly: true, phase: "plan_revise",
    });
    validatePlan(plan);
    await jsonFile(path.join(artifactDir, "plan.codex-revised.json"), plan);
    const planApproval = await this.runner.invoke("claude", {
      cwd: this.repo, prompt: finalPlanApprovalPrompt(goal, plan, planReview), schema: planReviewSchema, readOnly: true, phase: "plan_approval",
    });
    await jsonFile(path.join(artifactDir, "plan.claude-approval.json"), planApproval);

    const unresolved = consensusBlockers(plan, planApproval);
    const state = {
      runId: id, goal, baseRef: this.baseRef, baseSha, status: "planned", integrationBranch: null,
      plan, planApproval, tasks: [], tests: [], changedFiles: [], unresolved, prUrl: null,
    };
    if (unresolved.length) {
      state.status = "needs_input";
      await this.#finish(artifactDir, state);
      return state;
    }
    await jsonFile(path.join(artifactDir, "plan.agreed.json"), plan);

    const integrationBranch = `ai-team/${id}/integration`;
    const integrationWorktree = path.join(workRoot, "integration");
    await addWorktree(this.repo, integrationWorktree, integrationBranch, baseSha);
    state.integrationBranch = integrationBranch;

    const completed = new Set();
    while (completed.size < plan.tasks.length) {
      const ready = plan.tasks.filter((task) => !completed.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)));
      if (!ready.length) throw new Error("No runnable task remains.");
      for (const task of ready) {
        const taskState = await this.#runTask({ goal, plan, task, artifactDir, workRoot, integrationWorktree });
        state.tasks.push(taskState);
        if (taskState.status !== "complete") {
          state.status = "blocked";
          state.unresolved.push(taskState.error ?? `Task ${task.id} did not complete.`);
          await this.#finish(artifactDir, state);
          return state;
        }
        await cherryPick(integrationWorktree, taskState.commit);
        completed.add(task.id);
      }
    }

    const commands = [...new Set(plan.tasks.flatMap((task) => task.testCommands))];
    for (const command of commands) {
      try {
        await runSafeTest(integrationWorktree, command, this.timeoutMs);
        state.tests.push({ command, status: "passed" });
      } catch (error) {
        state.tests.push({ command, status: `failed: ${error.message}` });
        state.status = "blocked";
        state.unresolved.push(`Integration test failed: ${command}`);
        await this.#finish(artifactDir, state);
        return state;
      }
    }
    if (!commands.includes("npm run verify")) {
      try {
        await runSafeTest(integrationWorktree, "npm run verify", this.timeoutMs);
        state.tests.push({ command: "npm run verify", status: "passed" });
      } catch (error) {
        state.tests.push({ command: "npm run verify", status: `failed: ${error.message}` });
        state.status = "blocked";
        state.unresolved.push("Final npm run verify failed.");
        await this.#finish(artifactDir, state);
        return state;
      }
    }

    state.changedFiles = await diffFiles(integrationWorktree, baseSha);
    state.status = "ready_for_owner";
    if (createPr) state.prUrl = await this.#createPr(integrationWorktree, integrationBranch, pushRemote, goal, artifactDir);
    await this.#finish(artifactDir, state);
    return state;
  }

  async #runTask({ goal, plan, task, artifactDir, workRoot, integrationWorktree }) {
    const branch = `ai-team/${safeBranchPart(path.basename(workRoot))}/${safeBranchPart(task.id)}`;
    const taskWorktree = path.join(workRoot, task.id);
    const startPoint = (await git(integrationWorktree, ["rev-parse", "HEAD"])).stdout.trim();
    await addWorktree(this.repo, taskWorktree, branch, startPoint);
    const taskDir = path.join(artifactDir, "tasks", task.id);
    const result = { task, branch, worktree: taskWorktree, status: "running", implementation: null, reviews: [], changedFiles: [], commit: null, error: null };
    try {
      let repositoryContext = await taskFileContext(taskWorktree, task.ownedPaths);
      result.implementation = await this.runner.invoke(task.agent, {
        cwd: taskWorktree, prompt: implementationPrompt(goal, task, plan, repositoryContext), schema: implementationSchema, readOnly: false, phase: "implement",
      });
      await jsonFile(path.join(taskDir, "implementation.json"), result.implementation);
      const reviewer = task.agent === "codex" ? "claude" : "codex";
      for (let round = 1; round <= 3; round += 1) {
        const review = await this.runner.invoke(reviewer, {
          cwd: taskWorktree, prompt: reviewPrompt(goal, task, result.implementation, startPoint), schema: reviewSchema, readOnly: true, phase: "review",
        });
        result.reviews.push(review);
        await jsonFile(path.join(taskDir, `review-${round}.json`), review);
        const blockers = review.findings.filter((finding) => REVIEW_BLOCKERS.has(finding.severity));
        if (review.approved && blockers.length === 0) break;
        if (round === 3) throw new Error(`Task ${task.id} still has unresolved review findings after two revision rounds.`);
        repositoryContext = await taskFileContext(taskWorktree, task.ownedPaths);
        result.implementation = await this.runner.invoke(task.agent, {
          cwd: taskWorktree, prompt: revisionPrompt(goal, task, review, round, repositoryContext), schema: revisionSchema, readOnly: false, phase: "revise",
        });
        await jsonFile(path.join(taskDir, `revision-${round}.json`), result.implementation);
      }
      const currentHead = (await git(taskWorktree, ["rev-parse", "HEAD"])).stdout.trim();
      if (currentHead !== startPoint) throw new Error(`Task ${task.id} changed Git history; agents may edit files but may not commit or rebase.`);
      result.changedFiles = await validateTaskChanges(taskWorktree, task);
      for (const command of task.testCommands) await runSafeTest(taskWorktree, command, this.timeoutMs);
      result.commit = await commitTask(taskWorktree, task, result.changedFiles);
      result.status = "complete";
    } catch (error) {
      result.status = "blocked";
      result.error = error.message;
      result.changedFiles = await changedFiles(taskWorktree).catch(() => []);
    }
    await jsonFile(path.join(taskDir, "task-result.json"), result);
    return result;
  }

  async #createPr(worktree, branch, remote, goal, artifactDir) {
    if (branch === "main" || branch.endsWith("/main")) throw new Error("Refusing to push main.");
    await git(worktree, ["push", "--set-upstream", remote, branch], { timeoutMs: this.timeoutMs });
    const bodyFile = path.join(artifactDir, "pr-body.md");
    await writeFile(bodyFile, `Implements the AI-team goal:\n\n${goal}\n\nSee the generated run report for task, review, and validation details.\n`);
    const result = await runCommand("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `AI team: ${goal.slice(0, 60)}`, "--body-file", bodyFile], {
      cwd: worktree, timeoutMs: this.timeoutMs, env: safeEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
    });
    return result.stdout.trim().split("\n").at(-1);
  }

  async #finish(artifactDir, state) {
    await jsonFile(path.join(artifactDir, "run.json"), state);
    await writeFile(path.join(artifactDir, "final-report.md"), markdownReport(state));
  }
}
