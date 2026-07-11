# AGENTS.md

## Purpose

This repository contains personal pi coding-agent extensions used across projects. The code is intentionally practical and local-user focused rather than a polished public package.

The most important extension is `modes/`, which provides Claude Code-style operating modes:

- `normal`: regular work; safe inspection runs directly, changes and risky actions require approval.
- `research`: read-only code understanding and review.
- `plan`: read-only planning; produce and persist implementation plans.
- `brainstorming`: read-only brainstorming and feature shaping.
- `auto`: broader tool access with policy triage/review.

Other top-level files are small personal extensions such as status line/context helpers.

## User preferences and UX conventions

- Preserve working UX. Do not redesign flows unless explicitly asked.
- Avoid noisy messages. In particular:
  - Do not show a notification every time the mode changes.
  - Do not inject visible bookkeeping messages such as `[mode-plan-file]`.
  - Prefer status-line updates for persistent state.
  - Use notifications only for errors, approval prompts, or information the user explicitly needs.
- Plan files should be persisted quietly. The mode can ask what to do next, but saving itself should not create extra chat clutter.
- Brainstorming/plan prompts should borrow only the design-thinking part of Superpowers-style brainstorming: inspect context, clarify intent, decompose scope, compare alternatives, recommend, and stress-test. Do not import the full spec-writing/commit workflow or mandatory ceremony.
- Keep the design-thinking loop adaptive: strong enough to prevent premature implementation, but lightweight for small/local tasks.
- Do not add new commands unless the user asks for them.
- Keep implementation conservative and reviewable; prefer small targeted changes.

## Safety model

- Read-only modes must not modify filesystem, git state, packages, running processes, or remote state.
- Read-only modes may inspect files outside the current workspace. Do not restrict normal reads to `ctx.cwd`.
- The current policy layer does not implement secret-file path filtering by design; do not add broad file read filters unless explicitly requested.
- Shell safety should distinguish shell syntax from text inside quotes. For example, `rg "foo|bar"` is not a pipeline.
- Safe read-only pipelines are okay when each segment is safe, e.g. `find ... -type f | sort` or `rg TODO . | wc -l`.
- Unsafe shell composition should remain blocked or reviewed, e.g. `&&`, `;`, command substitution, process substitution, `tee` writes, or `curl | sh`.

## Code conventions

- TypeScript ESM with `.ts` imports.
- Prefer technical layering for larger extension areas, similar to `models.py` / `repositories.py` / `services.py` / `views.py` in Python web apps.
- Keep feature-level entrypoints where they clarify discovery and wiring, e.g. `modes/index.ts`, `subagents/index.ts`, and top-level extension files.
- Prefer technical module names that explain the role in the system:
  - `policies.ts` for allow/review/deny classification and permission policy.
  - `repositories.ts` for filesystem/session persistence helpers.
  - `services.ts` for orchestration and handoff logic.
  - `views.ts` for UI/approval rendering helpers.
  - `tools.ts` for custom pi tool registration and tool UI.
- Avoid vague names such as `safety.ts`, `review.ts`, or `artifacts.ts` for new larger modules; use the technical layer name instead.
- Keep pure policy and repository helpers testable.
- Prefer exact, simple helper functions over large opaque policy blobs.
- Avoid duplicating prompt text; shared prompt guidance belongs in `modes/shared/`.
- Do not rewrite or simplify mode prompt content unless explicitly asked; prompt wording is user-facing behavior.
- When editing files, use small precise changes and keep diffs easy to inspect.

## Verification

Before considering changes complete, run:

```bash
npm run typecheck
npm test
```

If changing `modes/policies.ts`, add or update tests in `tests/modes-utils.test.ts` for both the allowed case and the blocked/reviewed case.

## Current known important behavior

- `modes/` persists mode state in session custom entries.
- Active tools should respect the baseline active tool set rather than blindly enabling every registered tool.
- Plan/brainstorming modes should expose only baseline read-only tools.
- The plan artifact flow should save complete plans before asking the next-action question, so cancelling the selector does not lose the plan.
