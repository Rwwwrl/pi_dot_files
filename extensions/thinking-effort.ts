import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Direction = -1 | 1;

function getSupportedThinkingLevels(ctx: ExtensionContext): ThinkingLevel[] {
	const model = ctx.model;
	if (!model?.reasoning) return ["off"];

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function getNextThinkingLevel(current: ThinkingLevel, supportedLevels: ThinkingLevel[], direction: Direction): ThinkingLevel {
	const currentRank = THINKING_LEVELS.indexOf(current);
	const rankedLevels = supportedLevels
		.slice()
		.sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));

	if (direction > 0) {
		return rankedLevels.find((level) => THINKING_LEVELS.indexOf(level) > currentRank) ?? rankedLevels.at(-1) ?? current;
	}

	return [...rankedLevels].reverse().find((level) => THINKING_LEVELS.indexOf(level) < currentRank) ?? rankedLevels[0] ?? current;
}

function changeThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext, direction: Direction): void {
	const current = pi.getThinkingLevel();
	const next = getNextThinkingLevel(current, getSupportedThinkingLevels(ctx), direction);
	if (next !== current) pi.setThinkingLevel(next);
}

export default function thinkingEffortExtension(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+shift+down", {
		description: "Decrease thinking effort",
		handler: (ctx) => changeThinkingLevel(pi, ctx, -1),
	});

	pi.registerShortcut("ctrl+shift+up", {
		description: "Increase thinking effort",
		handler: (ctx) => changeThinkingLevel(pi, ctx, 1),
	});
}
