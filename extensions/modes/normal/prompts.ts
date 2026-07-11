import { buildModesOverlayPrompt } from "../prompts.ts";

export function buildNormalModePrompt(): string {
	return buildModesOverlayPrompt({ mode: "normal" });
}
