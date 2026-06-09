import { INTERACTIVE_QUESTION_GUIDANCE } from "../shared/prompts.ts";

export function buildNormalModePrompt(): string {
	return `[NORMAL MODE ACTIVE]
You are in normal mode. There is no special planning or execution intention wrapper. Allowlisted and research-gate-approved shell commands run directly. Blocklisted commands are blocked. File changes and edit/write calls require explicit user approval every time. Ambiguous non-write actions require explicit user approval. There is no automode safety reviewer in this mode.

${INTERACTIVE_QUESTION_GUIDANCE}`;
}
