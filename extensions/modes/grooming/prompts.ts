import { COLLABORATIVE_PLANNING_GUIDANCE } from "../shared/prompts.ts";

export function buildGroomingModePrompt(activePlanFile?: string): string {
	const activePlanLine = activePlanFile
		? `\nActive plan file: ${activePlanFile}. Grooming can brainstorm alternatives for this plan; when the user returns to plan mode, the plan should incorporate new decisions, assumptions, risks, open questions, and revised implementation direction.`
		: "";

	return `[GROOMING MODE ACTIVE]
You are in grooming mode. This is a read-only brainstorming and feature-shaping mode. Do not modify files or run state-changing commands.

${COLLABORATIVE_PLANNING_GUIDANCE}

Grooming output guidance:
- Prefer exploratory design notes, alternatives, constraints, risks, assumptions, decisions, open questions, approval checkpoints, and handoff notes for plan mode.
- When useful, structure output as: current understanding, scope/decomposition, options, tradeoffs, recommended direction, risks, open questions, and plan-mode handoff notes.
- Keep grooming distinct from plan mode: do not require an ordered implementation plan unless the user asks for one or the design is clearly mature enough.
- If the topic is underspecified, ask the next best clarifying question instead of producing a premature plan.${activePlanLine}`;
}
