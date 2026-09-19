const SAFETY = `
Mandatory safety rules:
- Read AGENTS.md, CLAUDE.md, docs/HANDOFF.md, docs/BUSINESS_RULES.md, docs/ARCHITECTURE.md and docs/OPERATIONS.md.
- Preserve approved analytics v7 semantics: ordinary SALES LOST qualifies for SQL and Sales Lost even without SQL-stage evidence.
- Never read or expose secrets. Never touch .vscode/. Never deploy, run Bitrix Sync or Backfill, mutate D1, or change Cloudflare Access.
- Never use dangerous permission-bypass flags, destructive commands, force pushes, or push to main.
- Escalate unresolved business decisions instead of guessing.
`;

export function planningPrompt(goal) {
  return `[AI_TEAM_PHASE:PLAN]\nYou are Codex, the planning lead. Independently propose a small, reviewable implementation plan for this goal:\n\n${goal}\n${SAFETY}
Use both Codex and Claude for implementation only where genuinely independent work exists. Each task must own non-overlapping paths, state dependencies, tests, and objective acceptance criteria. Return only the requested structured object.`;
}

export function planReviewPrompt(goal, plan) {
  return `[AI_TEAM_PHASE:PLAN_REVIEW]\nYou are Claude, independently reviewing Codex's proposed plan.\nGoal:\n${goal}\n\nPlan:\n${JSON.stringify(plan, null, 2)}\n${SAFETY}
Find missing dependencies, unsafe scope, overlapping ownership, weak acceptance criteria, and unresolved business decisions. Return only the requested structured object.`;
}

export function planRevisionPrompt(goal, plan, review) {
  return `[AI_TEAM_PHASE:PLAN_REVISE]\nYou are Codex. Produce the final agreed plan by incorporating Claude's actionable feedback.\nGoal:\n${goal}\n\nInitial plan:\n${JSON.stringify(plan, null, 2)}\n\nClaude review:\n${JSON.stringify(review, null, 2)}\n${SAFETY}
Do not dismiss unresolved decisions. Keep owned paths non-overlapping. Return only the requested structured object.`;
}

export function implementationPrompt(goal, task, plan) {
  return `[AI_TEAM_PHASE:IMPLEMENT]\nYou are ${task.agent}. Implement only this assigned task in the current isolated worktree.\nOriginal goal:\n${goal}\n\nTask:\n${JSON.stringify(task, null, 2)}\n\nAgreed plan summary:\n${plan.summary}\n${SAFETY}
You may edit only ownedPaths. Do not commit, push, create worktrees, or edit orchestration artifacts. Run the task's safe tests when useful. Return only the requested structured report.`;
}

export function reviewPrompt(goal, task, implementation, baseSha) {
  return `[AI_TEAM_PHASE:REVIEW]\nYou are the independent reviewer for ${task.agent}'s implementation. Review the current worktree changes against base ${baseSha}. Do not edit files.\nGoal:\n${goal}\n\nTask:\n${JSON.stringify(task, null, 2)}\n\nImplementer report:\n${JSON.stringify(implementation, null, 2)}\n${SAFETY}
Check correctness, scope, tests, security, and repository rules. Findings must be concrete and actionable. Approve only when no critical/high/medium findings remain. Return only the requested structured object.`;
}

export function revisionPrompt(goal, task, review, round) {
  return `[AI_TEAM_PHASE:REVISE]\nYou are ${task.agent}. Address every actionable review finding for round ${round} in the current isolated worktree.\nGoal:\n${goal}\n\nTask:\n${JSON.stringify(task, null, 2)}\n\nReview:\n${JSON.stringify(review, null, 2)}\n${SAFETY}
Edit only ownedPaths. Do not commit or push. Return only the requested structured report.`;
}
