import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { colorizeMode, parseMode } from "./modes/colors.ts";
import type { Mode } from "./modes/state.ts";

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return "?%";
	return `${Math.round(usage.percent)}%`;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractMode(status?: string): Mode | undefined {
	if (!status) return undefined;
	const plain = stripAnsi(status)
		.replace(/^mode:\s*/i, "")
		.split("|")[0]
		.trim();
	return parseMode(plain);
}

function getPriorityStatuses(statuses: ReadonlyMap<string, string>): Array<{ key: string; text: string }> {
	const result: Array<{ key: string; text: string }> = [];
	const seen = new Set<string>(["mode"]);

	for (const key of ["btw", "mode-progress"]) {
		const text = statuses.get(key);
		if (text) {
			result.push({ key, text });
			seen.add(key);
		}
	}

	for (const [key, text] of statuses) {
		if (seen.has(key) || !text) continue;
		const plain = stripAnsi(text).trim();
		if (plain.length === 0 || plain.length > 32) continue;
		result.push({ key, text });
		if (result.length >= 3) break;
	}

	return result;
}

function renderInline(left: string, right: string, width: number): string {
	if (width <= 0) return "";

	let leftText = left;
	let rightText = right;
	let gap = leftText && rightText ? 1 : 0;

	if (visibleWidth(leftText) + gap + visibleWidth(rightText) > width) {
		leftText = truncateToWidth(leftText, Math.max(0, width - gap - visibleWidth(rightText)), "…");
	}

	gap = leftText && rightText ? 1 : 0;
	if (visibleWidth(leftText) + gap + visibleWidth(rightText) > width) {
		rightText = truncateToWidth(rightText, Math.max(0, width - gap - visibleWidth(leftText)), "…");
	}

	gap = leftText && rightText ? Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)) : 0;
	return truncateToWidth(`${leftText}${" ".repeat(gap)}${rightText}`, width, "");
}

export default function statuslineExtension(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;

	const refresh = () => requestRender?.();

	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("message_end", refresh);
	pi.on("turn_end", refresh);
	pi.on("agent_end", refresh);
	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribeBranch();
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();
					const statuses = footerData.getExtensionStatuses();
					const mode = extractMode(statuses.get("mode"));

					const extraStatuses = getPriorityStatuses(statuses).map(({ text }) => text);
					const projectParts = [
						theme.fg("dim", formatCwd(ctx.cwd)),
						branch ? theme.fg("muted", ` ${branch}`) : undefined,
					].filter((part): part is string => Boolean(part));
					const modeParts = [mode ? colorizeMode(mode) : undefined, ...extraStatuses].filter(
						(part): part is string => Boolean(part),
					);

					const model = ctx.model?.id ?? "no-model";
					const effort = pi.getThinkingLevel();
					const innerWidth = Math.max(0, width - 2);
					const projectLine = renderInline(projectParts.join(" "), "", innerWidth);
					const modeLine = renderInline(
						modeParts.join(" "),
						[theme.fg("dim", `${model} · ${effort}`), theme.fg("dim", formatContext(ctx))].join(" "),
						innerWidth,
					);

					if (width <= 1) return [" ".slice(0, width), " ".slice(0, width)];
					return [` ${projectLine} `, ` ${modeLine} `];
				},
			};
		});
	});
}
