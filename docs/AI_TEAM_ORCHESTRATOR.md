# AI team orchestrator

`npm run ai-team` coordinates the locally authenticated Codex and Claude Code
CLIs around one end-result goal. It is a small Node.js tool with no additional
runtime dependencies.

## Workflow

1. Codex proposes a structured plan in read-only mode.
2. Claude reviews the plan independently in read-only mode.
3. Codex produces the agreed plan with dependencies, path ownership, tests and
   acceptance criteria.
4. A blocking business decision stops the run before any worktree is created.
5. Each task gets its own Git branch and worktree. The assigned agent edits only
   its declared paths.
6. The other agent reviews the uncommitted task diff. Actionable findings return
   to the implementer for at most two revision rounds.
7. Approved task commits are cherry-picked into a dedicated integration branch.
8. Declared safe tests and `npm run verify` run on the integrated result.
9. The run emits a consolidated report and optionally opens one pull request.

The orchestrator never merges into `main`.

## Prerequisites

- A clean Git worktree.
- Existing `node_modules` from `npm ci` or `npm run install:ci`.
- Locally authenticated `codex` and `claude` commands.
- GitHub CLI authentication only when `--create-pr` is requested.

Check the installed CLI versions and required noninteractive flags:

```bash
npm run ai-team -- doctor
```

## Safe dry run

This creates a temporary fixture repository and invokes only the committed mock
executables. It exercises planning, two agent worktrees, reciprocal reviews,
integration and verification without calling either AI service:

```bash
npm run ai-team -- dry-run
```

The command prints the temporary repository path so the branches and artifacts
can be inspected.

## Run a real goal

Pass one natural-language goal directly:

```bash
npm run ai-team -- run \
  --goal "Add a documented, tested health check for the local reporting cache"
```

Or use a UTF-8 goal file:

```bash
npm run ai-team -- run --goal-file docs/next-goal.md --base main
```

By default the command produces a PR-ready local branch named
`ai-team/<run-id>/integration`. To push that branch and open one PR:

```bash
npm run ai-team -- run --goal-file docs/next-goal.md --base main --create-pr
```

That flag never pushes or merges `main`. A failed task, review, conflict or test
leaves the run blocked for inspection.

## Artifacts

Local, ignored artifacts live under `.ai-team/runs/<run-id>/`:

- original goal;
- Codex plan, Claude review and agreed plan;
- implementation and review reports for each task;
- final machine-readable run state;
- consolidated `final-report.md`.

Task and integration worktrees live under `.ai-team/worktrees/<run-id>/`. They
are retained so the owner can inspect a blocked or completed run. Remove them
with normal `git worktree remove` commands only after the work is accepted or
abandoned.

## Safety boundary

The subprocess environment is allowlisted and removes variables whose names may
contain credentials. Prompts repeat the repository's safety rules. Codex uses a
workspace sandbox; Claude receives a bounded tool list and a noninteractive mode
that denies permission prompts. Neither dangerous bypass flag is used.

The tool rejects `.vscode/` changes, edits outside task ownership, credential-
shaped Bitrix URLs and shell test commands outside a narrow test/build allowlist.
It imposes explicit process timeouts and caps captured output. It does not run
deploy, Sync, Backfill, D1, Cloudflare Access, force-push or automatic merge
operations.

These controls reduce automation risk; they do not turn an AI-generated change
into trusted code. The owner must inspect the agreed plan, diff, reviews and
test results before accepting the PR.
