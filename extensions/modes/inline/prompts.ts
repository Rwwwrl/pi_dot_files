import { buildModesOverlayPrompt } from "../prompts.ts";

export function buildInlineModePrompt(): string {
	return buildModesOverlayPrompt({ mode: "inline" });
}
