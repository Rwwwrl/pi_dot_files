import { buildModesOverlayPrompt } from "../prompts.ts";

export function buildBrainstormingModePrompt(activePlanFile?: string): string {
	return buildModesOverlayPrompt({ mode: "brainstorming", activePlanFile });
}
