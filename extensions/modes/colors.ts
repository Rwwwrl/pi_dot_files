import type { Mode } from "./state.ts";

const MODE_FG_HEX: Record<Mode, string> = {
	normal: "#7DD3FC",
	inline: "#34D399",
	research: "#A78BFA",
	plan: "#FACC15",
	brainstorming: "#FB923C",
	auto: "#F87171",
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace(/^#/, "");
	const r = Number.parseInt(cleaned.slice(0, 2), 16);
	const g = Number.parseInt(cleaned.slice(2, 4), 16);
	const b = Number.parseInt(cleaned.slice(4, 6), 16);
	return { r, g, b };
}

export function modeColorHex(mode: Mode): string {
	return MODE_FG_HEX[mode];
}

export function colorizeMode(mode: Mode, text: string = mode): string {
	const { r, g, b } = hexToRgb(modeColorHex(mode));
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function parseMode(value: string | undefined): Mode | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["normal", "inline", "research", "plan", "brainstorming", "auto"].includes(normalized)) return normalized as Mode;
	return undefined;
}
