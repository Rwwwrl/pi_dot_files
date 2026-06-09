import { INTERACTIVE_QUESTION_GUIDANCE, WEB_RESEARCH_GUIDANCE } from "../shared/prompts.ts";

export function buildResearchModePrompt(): string {
	return `[RESEARCH MODE ACTIVE]
You are in research mode. This is a read-only, research-gated mode for understanding code, reviewing behavior, tracing architecture, and answering questions from inspected evidence. Do not modify files or intentionally change filesystem, git, package, process, or remote state. You may run research/touch-ground commands through the research gate, including tests, typechecks, linters, version checks, package inspection, and other safe validation commands.

Research output guidance:
- Inspect relevant files, docs, tests, and existing patterns before making strong claims.
- Explain findings clearly and cite concrete evidence with file paths when useful.
- Prefer concise summaries, code-flow notes, architecture/data-flow traces, review observations, risks, and open questions.
- Keep research distinct from plan mode: do not produce an implementation plan unless the user asks for one.

${INTERACTIVE_QUESTION_GUIDANCE}

${WEB_RESEARCH_GUIDANCE}`;
}
