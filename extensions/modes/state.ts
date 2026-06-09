export type Mode = "normal" | "research" | "plan" | "brainstorming" | "auto";

const MODE_MARKERS: Array<{ marker: string; mode: Mode }> = [
	{ marker: "[NORMAL MODE ACTIVE]", mode: "normal" },
	{ marker: "[RESEARCH MODE ACTIVE]", mode: "research" },
	{ marker: "[PLAN MODE ACTIVE]", mode: "plan" },
	{ marker: "[BRAINSTORMING MODE ACTIVE]", mode: "brainstorming" },
	{ marker: "[AUTOMODE ACTIVE]", mode: "auto" },
];

let currentMode: Mode = "normal";

export function getCurrentMode(): Mode {
	return currentMode;
}

export function setCurrentMode(mode: Mode): void {
	currentMode = mode;
}

export function normalizePersistedMode(value: unknown): Mode | undefined {
	return ["normal", "research", "plan", "brainstorming", "auto"].includes(value as Mode) ? (value as Mode) : undefined;
}

export interface ModeResolutionContext {
	getSystemPrompt?: () => string;
	sessionManager?: {
		getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
	};
}

export function resolveCurrentMode(ctx?: ModeResolutionContext): Mode {
	const systemPrompt = ctx?.getSystemPrompt?.() ?? "";
	for (const { marker, mode } of MODE_MARKERS) {
		if (systemPrompt.includes(marker)) return mode;
	}

	const entries = ctx?.sessionManager?.getBranch?.() ?? [];
	const modeEntry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === "modes")
		.pop();
	const data = modeEntry?.data as { mode?: unknown } | undefined;
	const persistedMode = normalizePersistedMode(data?.mode);
	return persistedMode ?? currentMode;
}
