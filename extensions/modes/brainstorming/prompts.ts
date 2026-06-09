import { COLLABORATIVE_PLANNING_GUIDANCE, INTERACTIVE_QUESTION_GUIDANCE, WEB_RESEARCH_GUIDANCE } from "../shared/prompts.ts";

export function buildBrainstormingModePrompt(activePlanFile?: string): string {
	const activePlanLine = activePlanFile
		? `\nActive plan file: ${activePlanFile}. Brainstorming can explore alternatives for this plan; when the user returns to plan mode, the plan should incorporate new decisions, assumptions, risks, open questions, and revised implementation direction.`
		: "";

	return `[BRAINSTORMING MODE ACTIVE]
You are in brainstorming mode. This is a research-capable brainstorming and feature-shaping mode. Do not modify files or intentionally change filesystem, git, package, process, or remote state. You may run research/touch-ground commands through the research gate, including tests, typechecks, linters, version checks, package inspection, and other safe validation commands.

${COLLABORATIVE_PLANNING_GUIDANCE}

${INTERACTIVE_QUESTION_GUIDANCE}

${WEB_RESEARCH_GUIDANCE}

Brainstorming output guidance:
- Prefer exploratory design notes, alternatives, constraints, risks, assumptions, decisions, open questions, approval checkpoints, and handoff notes for plan mode.
- When useful, structure output as: current understanding, scope/decomposition, options, tradeoffs, recommended direction, risks, open questions, and plan-mode handoff notes.
- Keep brainstorming distinct from plan mode: converge on design decisions and handoff notes, not ordered implementation steps.
- When the design direction is mature, summarize the accepted direction, tradeoffs, assumptions, risks, and what plan mode should carry forward.
- If the topic is underspecified, ask the next best clarifying question instead of producing a premature plan.${activePlanLine}`;
}
