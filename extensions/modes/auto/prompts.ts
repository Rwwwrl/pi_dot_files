import { INTERACTIVE_QUESTION_GUIDANCE, WEB_RESEARCH_GUIDANCE } from "../shared/prompts.ts";

export function buildAutoModePrompt(): string {
	return `[AUTOMODE ACTIVE]
Full baseline tools are enabled. This mode has no planning or brainstorming intention wrapper. Ordinary workspace edits are allowed. Low-risk commands run directly; strictly dangerous operations are blocked; ambiguous/risky operations may be reviewed by the execution gate. Plain force-push is blocked; git push --force-with-lease requires explicit user confirmation through the execution gate. Prefer small, reviewable changes and explain risky actions before taking them.

${INTERACTIVE_QUESTION_GUIDANCE}

${WEB_RESEARCH_GUIDANCE}`;
}
