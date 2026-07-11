import { buildModesOverlayPrompt } from "../prompts.ts";

export function buildResearchModePrompt(): string {
	return buildModesOverlayPrompt({ mode: "research" });
}
