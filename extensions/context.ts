import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const BAR_WIDTH = 24;
const MAX_CONTEXT_FILES = 12;
const MAX_TOOLS = 16;
const nf = new Intl.NumberFormat("en-US");

function formatNumber(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? nf.format(Math.round(value)) : "unknown";
}

function formatPercent(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "unknown";
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function formatTextTokens(text: string): string {
	return `${nf.format(estimateTextTokens(text))} tokens`;
}

function makeBar(percent: number | null | undefined): string {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return "[????????????????????????]";
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
}

function getMessageRole(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const role = (entry.message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

function countByRole(entries: SessionEntry[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of entries) {
		const role = getMessageRole(entry);
		if (!role) continue;
		counts[role] = (counts[role] ?? 0) + 1;
	}
	return counts;
}

function latestCompaction(entries: SessionEntry[]): (SessionEntry & { type: "compaction" }) | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") return entry;
	}
	return undefined;
}

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function formatList(items: string[], maxItems: number): string[] {
	if (items.length <= maxItems) return items;
	return [...items.slice(0, maxItems), `… ${items.length - maxItems} more`];
}

function buildContextReport(ctx: ExtensionCommandContext, activeTools: string[]): string {
	const usage = ctx.getContextUsage();
	const remaining = usage?.tokens === null || usage?.tokens === undefined ? null : Math.max(0, usage.contextWindow - usage.tokens);
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const promptOptions = ctx.getSystemPromptOptions();
	const systemPrompt = ctx.getSystemPrompt();
	const branch = ctx.sessionManager.getBranch();
	const entries = ctx.sessionManager.getEntries();
	const roleCounts = countByRole(branch);
	const contextFiles = promptOptions.contextFiles ?? [];
	const tools = activeTools.length > 0 ? activeTools : (promptOptions.selectedTools ?? []);
	const skills = promptOptions.skills ?? [];
	const compacted = latestCompaction(branch);

	const lines = [
		"Context",
		`${makeBar(usage?.percent)} ${formatPercent(usage?.percent)} used`,
		"",
		`Model: ${model}`,
		`Context window: ${formatNumber(usage?.contextWindow)} tokens`,
		`Used: ${formatNumber(usage?.tokens)} tokens`,
		`Remaining: ${formatNumber(remaining)} tokens`,
		`System prompt: ${formatTextTokens(systemPrompt)}`,
		"",
		`Session: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`,
		`Branch entries: ${nf.format(branch.length)} / ${nf.format(entries.length)} total`,
		`Messages: user ${roleCounts.user ?? 0}, assistant ${roleCounts.assistant ?? 0}, tool results ${roleCounts.toolResult ?? 0}`,
	];

	if (compacted) {
		lines.push(`Last compaction: ${formatTimestamp(compacted.timestamp)} (${formatNumber(compacted.tokensBefore)} tokens before)`);
	}

	lines.push("", `Context files (${contextFiles.length}):`);
	if (contextFiles.length === 0) {
		lines.push("  none");
	} else {
		for (const file of formatList(
			contextFiles.map((file) => `${file.path} (${formatTextTokens(file.content)})`),
			MAX_CONTEXT_FILES,
		)) {
			lines.push(`  ${file}`);
		}
	}

	lines.push("", `Tools (${tools.length}):`);
	if (tools.length === 0) {
		lines.push("  none");
	} else {
		lines.push(`  ${formatList(tools, MAX_TOOLS).join(", ")}`);
	}

	lines.push("", `Skills (${skills.length}):`);
	if (skills.length === 0) {
		lines.push("  none");
	} else {
		for (const skill of formatList(skills.map((skill) => skill.name), MAX_CONTEXT_FILES)) {
			lines.push(`  ${skill}`);
		}
	}

	return lines.join("\n");
}

export default function contextExtension(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show current context usage and loaded context",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildContextReport(ctx, pi.getActiveTools()), "info");
		},
	});
}
