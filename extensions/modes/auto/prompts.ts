import { buildModesOverlayPrompt } from "../prompts.ts";

export function buildAutoModePrompt(): string {
	return buildModesOverlayPrompt({ mode: "auto" });
}
