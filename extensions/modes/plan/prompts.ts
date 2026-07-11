import { buildModesOverlayPrompt } from "../prompts.ts";

export function buildPlanModePrompt(activePlanFile?: string): string {
	return buildModesOverlayPrompt({ mode: "plan", activePlanFile });
}
