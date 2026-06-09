import type { AssistantMessage, Message, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { Mode } from "../modes/state.ts";

export const MAX_TASKS = 8;
export const DEFAULT_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export const CHILD_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "web_research", "web_fetch"] as const;

export type SubagentParentMode = Extract<Mode, "research" | "plan" | "brainstorming">;
export type ChildModeFlag = "--research" | "--brainstorming";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentResult {
	index: number;
	title?: string;
	task: string;
	parentMode: SubagentParentMode;
	childMode: "research" | "brainstorming";
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function isSubagentParentMode(mode: Mode): mode is SubagentParentMode {
	return mode === "research" || mode === "plan" || mode === "brainstorming";
}

export function childModeFlagForParentMode(mode: SubagentParentMode): ChildModeFlag {
	return mode === "brainstorming" ? "--brainstorming" : "--research";
}

export function childModeNameForParentMode(mode: SubagentParentMode): "research" | "brainstorming" {
	return mode === "brainstorming" ? "brainstorming" : "research";
}

export function clampConcurrency(value: unknown, taskCount: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return Math.min(DEFAULT_CONCURRENCY, Math.max(1, taskCount));
	return Math.max(1, Math.min(DEFAULT_CONCURRENCY, taskCount, Math.trunc(value)));
}

export function createEmptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function buildSubagentPrompt(mode: SubagentParentMode, task: string, title?: string): string {
	const label = title?.trim() ? `\nTask title: ${title.trim()}` : "";
	const planNote =
		mode === "plan"
			? "\nParent mode is plan. You are a research subagent supporting the parent plan. Return evidence, constraints, risks, options, and open questions; do not write or persist the final implementation plan."
			: "";

	return `You are an isolated subagent reporting back to a parent pi agent.${label}${planNote}

Subagent rules:
- Work independently on only the delegated task below.
- Use the inherited research-mode prompt, research-gated tools, and web tools when helpful.
- Bash is available through the research gate for inspection, tests, typechecks, and other safe validation commands.
- Do not intentionally modify files, git state, packages, processes, or remote state.
- Do not ask the user questions; surface open questions for the parent agent instead.
- Report concrete findings with file paths, URLs, commands run, assumptions, uncertainty, and risks.
- Do not make final user-facing decisions; the parent agent will synthesize all subagent findings.

Delegated task:
${task.trim()}`;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const content = Array.isArray((msg as { content?: unknown }).content) ? msg.content : [];
		const text = content
			.filter(isTextContent)
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export function getToolCalls(messages: Message[]): Array<{ name: string; arguments: Record<string, unknown> }> {
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const content = Array.isArray((msg as { content?: unknown }).content) ? msg.content : [];
		for (const part of content) {
			if (isToolCall(part)) calls.push({ name: part.name, arguments: part.arguments });
		}
	}
	return calls;
}

export function isFailedResult(result: SubagentResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function shouldMarkSubagentsError(results: SubagentResult[]): boolean {
	return results.length > 0 && results.every(isFailedResult);
}

export function getResultOutput(result: SubagentResult): string {
	if (isFailedResult(result)) return result.errorMessage || result.stderr.trim() || getFinalOutput(result.messages) || "(no output)";
	return getFinalOutput(result.messages) || "(no output)";
}

export function truncateTaskOutput(output: string, maxBytes = PER_TASK_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= maxBytes) return output;

	let truncated = output.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output is preserved in tool details.]`;
}

export function applyJsonEventToResult(result: SubagentResult, rawLine: string): boolean {
	if (!rawLine.trim()) return false;

	let event: unknown;
	try {
		event = JSON.parse(rawLine);
	} catch {
		return false;
	}

	if (!event || typeof event !== "object") return false;
	const typed = event as { type?: unknown; message?: unknown };
	if ((typed.type === "message_end" || typed.type === "tool_result_end") && isMessage(typed.message)) {
		result.messages.push(typed.message);
		if (typed.message.role === "assistant") updateAssistantStats(result, typed.message);
		return true;
	}

	return false;
}

function updateAssistantStats(result: SubagentResult, message: AssistantMessage): void {
	result.usage.turns++;
	result.usage.input += message.usage?.input ?? 0;
	result.usage.output += message.usage?.output ?? 0;
	result.usage.cacheRead += message.usage?.cacheRead ?? 0;
	result.usage.cacheWrite += message.usage?.cacheWrite ?? 0;
	result.usage.cost += message.usage?.cost?.total ?? 0;
	result.usage.contextTokens = message.usage?.totalTokens ?? result.usage.contextTokens;
	result.model = result.model ?? message.model;
	result.stopReason = message.stopReason;
	result.errorMessage = message.errorMessage;
}

function isTextContent(value: unknown): value is TextContent {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as { type?: unknown }).type === "text" &&
			typeof (value as { text?: unknown }).text === "string",
	);
}

function isToolCall(value: unknown): value is ToolCall {
	if (!value || typeof value !== "object") return false;
	const typed = value as { type?: unknown; name?: unknown; arguments?: unknown };
	return typed.type === "toolCall" && typeof typed.name === "string" && isRecord(typed.arguments);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMessage(value: unknown): value is Message {
	if (!value || typeof value !== "object") return false;
	const typed = value as { role?: unknown; content?: unknown };
	if (typed.role === "user") return typeof typed.content === "string" || Array.isArray(typed.content);
	if (typed.role === "assistant" || typed.role === "toolResult") return Array.isArray(typed.content);
	return false;
}
