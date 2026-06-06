# AGENTS.md

## Purpose

This repository contains personal pi coding-agent extensions used across projects. The code is intentionally practical and local-user focused rather than a polished public package.

The most important extension is `modes/`, which provides Claude Code-style operating modes:

- `normal`: regular work; safe inspection runs directly, changes and risky actions require approval.
- `plan`: read-only planning; produce and persist implementation plans.
- `grooming`: read-only brainstorming and feature shaping.
- `auto`: broader tool access with safety triage/review.

Other top-level files are small personal extensions such as status line/context helpers.

## User preferences and UX conventions

- Preserve working UX. Do not redesign flows unless explicitly asked.
- Avoid noisy messages. In particular:
  - Do not show a notification every time the mode changes.
  - Do not inject visible bookkeeping messages such as `[mode-plan-file]`.
  - Prefer status-line updates for persistent state.
  - Use notifications only for errors, approval prompts, or information the user explicitly needs.
- Plan files should be persisted quietly. The mode can ask what to do next, but saving itself should not create extra chat clutter.
- Do not add new commands unless the user asks for them.
- Keep implementation conservative and reviewable; prefer small targeted changes.

## Safety model

- Read-only modes must not modify filesystem, git state, packages, running processes, or remote state.
- Read-only modes may inspect files outside the current workspace. Do not restrict normal reads to `ctx.cwd`.
- Secret inspection should be blocked, even if the operation is otherwise read-only. Treat at least these as sensitive:
  - `.env`, `.env.*`
  - SSH private keys
  - `.npmrc`, `.pypirc`, `.netrc`
  - credential/secret/token/key files
  - direct `.git` internals access
- Shell safety should distinguish shell syntax from text inside quotes. For example, `rg "foo|bar"` is not a pipeline.
- Safe read-only pipelines are okay when each segment is safe, e.g. `find ... -type f | sort` or `rg TODO . | wc -l`.
- Unsafe shell composition should remain blocked or reviewed, e.g. `&&`, `;`, command substitution, process substitution, `tee` writes, or `curl | sh`.

## Code conventions

- TypeScript ESM with `.ts` imports.
- Keep pure safety and artifact helpers testable.
- Prefer exact, simple helper functions over large opaque policy blobs.
- Avoid duplicating prompt text; shared prompt guidance belongs in `modes/shared/`.
- When editing files, use small precise changes and keep diffs easy to inspect.

## Verification

Before considering changes complete, run:

```bash
npm run typecheck
npm test
```

If changing `modes/auto/safety.ts`, add or update tests in `tests/modes-utils.test.ts` for both the allowed case and the blocked/reviewed case.

## Current known important behavior

- `modes/` persists mode state in session custom entries.
- Active tools should respect the baseline active tool set rather than blindly enabling every registered tool.
- Plan/grooming modes should expose only baseline read-only tools.
- The plan artifact flow should save complete plans before asking the next-action question, so cancelling the selector does not lose the plan.
