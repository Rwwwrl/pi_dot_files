import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveCurrentMode } from "../modes/state.ts";
import {
	applyJsonEventToResult,
	buildSubagentPrompt,
	CHILD_TOOL_NAMES,
	childModeFlagForParentMode,
	childModeNameForParentMode,
	clampConcurrency,
	createEmptyUsage,
	getResultOutput,
	getToolCalls,
	getModelSpec,
	isFailedResult,
	isSubagentParentMode,
	normalizeSubagentInvocation,
	shouldMarkSubagentsError,
	truncateTaskOutput,
	type SubagentInvocationMode,
	type SubagentParentMode,
	type SubagentPurpose,
	type SubagentResult,
	type SubagentsToolParams,
} from "./utils.ts";

const SUBAGENTS_PARAMETERS = {
	type: "object",
	properties: {
		tasks: {
			type: "array",
			description:
				"Targeted research, review, scouting, or decomposition tasks to run in isolated parallel subagents. Use this when the user asks for specific delegated work.",
			items: {
				type: "object",
				properties: {
					title: { type: "string", description: "Short display title for this task." },
					task: { type: "string", description: "The complete delegated task for this subagent." },
				},
				required: ["task"],
				additionalProperties: false,
			},
		},
		ideation: {
			type: "object",
			description:
				"Divergent brainstorming mode: run several isolated agents on the same neutral problem statement for open-ended solution discovery.",
			properties: {
				title: { type: "string", description: "Optional base display title for the generated ideation agents." },
				task: { type: "string", description: "The neutral problem statement every ideation agent should receive." },
				count: { type: "number", description: "Number of ideation agents to run. Defaults to 4; capped at 8." },
			},
			required: ["task"],
			additionalProperties: false,
		},
		maxConcurrency: {
			type: "number",
			description: "Maximum number of child agents to run at once. Defaults to 4; capped at 4.",
		},
	},
	additionalProperties: false,
} as ToolDefinition["parameters"];

interface SubagentsDetails {
	parentMode: SubagentParentMode;
	invocationMode?: SubagentInvocationMode;
	childTools: string[];
	results: SubagentResult[];
}

type OnUpdate =
	| ((partial: { content: Array<{ type: "text"; text: string }>; details: SubagentsDetails; isError?: boolean }) => void)
	| undefined;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

function buildChildArgs(mode: SubagentParentMode, prompt: string, modelSpec: string | undefined): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		childModeFlagForParentMode(mode),
		"--tools",
		CHILD_TOOL_NAMES.join(","),
	];
	if (modelSpec) args.push("--model", modelSpec);
	args.push(prompt);
	return args;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	signal?: AbortSignal,
): Promise<TOut[]> {
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(Math.max(1, Math.min(concurrency, items.length))).fill(null).map(async () => {
		while (true) {
			if (signal?.aborted) return;
			const current = nextIndex++;
			if (current >= items.length) return;
			if (signal?.aborted) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function runSubagent(options: {
	index: number;
	title?: string;
	task: string;
	purpose: SubagentPurpose;
	parentMode: SubagentParentMode;
	cwd: string;
	modelSpec?: string;
	signal: AbortSignal | undefined;
	onResultUpdate: (result: SubagentResult) => void;
}): Promise<SubagentResult> {
	const result: SubagentResult = {
		index: options.index,
		title: options.title,
		task: options.task,
		parentMode: options.parentMode,
		childMode: childModeNameForParentMode(options.parentMode),
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: createEmptyUsage(),
	};
	const prompt = buildSubagentPrompt(options.parentMode, options.task, options.title, options.purpose);
	const args = buildChildArgs(options.parentMode, prompt, options.modelSpec);

	if (options.signal?.aborted) {
		result.exitCode = 1;
		result.stopReason = "aborted";
		result.errorMessage = "Subagent was aborted.";
		options.onResultUpdate(result);
		return result;
	}

	let wasAborted = false;
	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		let settled = false;
		let closed = false;

		const processLine = (line: string) => {
			const changed = applyJsonEventToResult(result, line);
			if (changed) options.onResultUpdate(result);
		};

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (buffer.trim()) processLine(buffer);
			resolve(code);
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => {
			result.stderr += data.toString("utf8");
		});

		proc.on("close", (code) => {
			closed = true;
			finish(code ?? 0);
		});
		proc.on("error", (error) => {
			result.stderr += `${error.message}\n`;
			finish(1);
		});

		let killProc: (() => void) | undefined;
		if (options.signal) {
			killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!closed) proc.kill("SIGKILL");
				}, 5000).unref();
			};
			if (options.signal.aborted) killProc();
			else options.signal.addEventListener("abort", killProc, { once: true });
		}

		proc.on("close", () => {
			if (killProc) options.signal?.removeEventListener("abort", killProc);
		});
	});

	result.exitCode = exitCode;
	if (wasAborted) {
		result.stopReason = "aborted";
		result.errorMessage = "Subagent was aborted.";
	}
	options.onResultUpdate(result);
	return result;
}

function summarizeForModel(results: SubagentResult[]): string {
	const successCount = results.filter((result) => !isFailedResult(result)).length;
	const sections = results.map((result) => {
		const title = result.title ? `${result.index + 1}. ${result.title}` : `${result.index + 1}. Task`;
		const status = isFailedResult(result)
			? `failed${result.stopReason && result.stopReason !== "stop" ? ` (${result.stopReason})` : ""}`
			: "completed";
		return `## ${title} — ${status}\n\n${truncateTaskOutput(getResultOutput(result))}`;
	});
	return `Subagents completed: ${successCount}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
}

function buildStatusText(results: SubagentResult[]): string {
	const done = results.filter((result) => result.exitCode !== -1).length;
	const running = results.length - done;
	return `Subagents: ${done}/${results.length} done${running > 0 ? `, ${running} running` : ""}`;
}

function markAbortedResult(result: SubagentResult): SubagentResult {
	return { ...result, exitCode: 1, stopReason: "aborted", errorMessage: "Subagent was aborted." };
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagents",
		label: "Subagents",
		description:
			"Run isolated read-only subagents in parallel for targeted delegation or divergent ideation. Available in research, plan, and brainstorming modes.",
		promptSnippet: "Run isolated read-only subagents for targeted tasks or same-problem divergent ideation",
		promptGuidelines: [
			"Use subagents.tasks for targeted research, review, scouting, decomposition, or internet/documentation research when the user asks for specific delegated work.",
			"Use subagents.ideation for open-ended solution discovery in brainstorming mode: run several isolated agents on the same neutral problem statement before synthesizing options.",
			"Do not force subagents.ideation for every brainstorming request; preserve subagents.tasks when the user asks to spin an agent for a specific research or safety-check task.",
			"For subagents.ideation, do not preselect approaches or assign solution categories; let each child independently discover possible options, then synthesize overlaps, disagreements, caveats, risks, and open questions.",
			"Subagents run child research/brainstorming modes with research-gated bash for inspection and validation; do not use subagents for implementation work.",
		],
		parameters: SUBAGENTS_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mode = resolveCurrentMode(ctx);
			if (!isSubagentParentMode(mode)) {
				return {
					content: [{ type: "text", text: "subagents is available only in research, plan, and brainstorming modes." }],
					details: { parentMode: "research", childTools: [...CHILD_TOOL_NAMES], results: [] },
					isError: true,
				};
			}

			const typed = params as unknown as SubagentsToolParams;
			const invocation = normalizeSubagentInvocation(typed);
			if (!invocation.ok) {
				return {
					content: [{ type: "text", text: invocation.error }],
					details: { parentMode: mode, childTools: [...CHILD_TOOL_NAMES], results: [] },
					isError: true,
				};
			}

			const tasks = invocation.tasks;
			const results: SubagentResult[] = tasks.map((task, index) => ({
				index,
				title: task.title,
				task: task.task,
				parentMode: mode,
				childMode: childModeNameForParentMode(mode),
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: createEmptyUsage(),
			}));
			const details = (): SubagentsDetails => ({
				parentMode: mode,
				invocationMode: invocation.mode,
				childTools: [...CHILD_TOOL_NAMES],
				results: [...results],
			});
			const emitUpdate = () => {
				(onUpdate as OnUpdate)?.({ content: [{ type: "text", text: buildStatusText(results) }], details: details() });
			};
			emitUpdate();

			const modelSpec = getModelSpec(ctx.model, pi.getThinkingLevel());
			const concurrency = clampConcurrency(typed.maxConcurrency, tasks.length);
			await mapWithConcurrencyLimit(
				tasks,
				concurrency,
				async (task, index) => {
					const result = await runSubagent({
						index,
						title: task.title,
						task: task.task,
						purpose: task.purpose,
						parentMode: mode,
						cwd: ctx.cwd,
						modelSpec,
						signal,
						onResultUpdate: (partial) => {
							results[index] = partial;
							emitUpdate();
						},
					});
					results[index] = result;
					emitUpdate();
					return result;
				},
				signal,
			);

			const finalResults = results.map((result) => (signal?.aborted && result.exitCode === -1 ? markAbortedResult(result) : result));
			if (signal?.aborted) {
				for (const result of finalResults) results[result.index] = result;
				emitUpdate();
			}

			const hasFailures = shouldMarkSubagentsError(finalResults);
			return {
				content: [{ type: "text", text: summarizeForModel(finalResults) }],
				details: { parentMode: mode, invocationMode: invocation.mode, childTools: [...CHILD_TOOL_NAMES], results: finalResults },
				isError: hasFailures,
			};
		},
		renderCall(args, theme) {
			const typedArgs = args as SubagentsToolParams;
			if (typedArgs.ideation) {
				const rawCount =
					typeof typedArgs.ideation.count === "number" && Number.isFinite(typedArgs.ideation.count)
						? Math.trunc(typedArgs.ideation.count)
						: 4;
				const count = Math.max(1, Math.min(8, rawCount));
				return new Text(
					theme.fg("toolTitle", theme.bold("subagents ")) +
						theme.fg("accent", `ideation ${count} agent${count === 1 ? "" : "s"}`),
					0,
					0,
				);
			}
			const count = Array.isArray(typedArgs.tasks) ? typedArgs.tasks.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("subagents ")) + theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentsDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const lines = [buildStatusText(details.results)];
			for (const item of details.results) {
				const icon = item.exitCode === -1 ? "⏳" : isFailedResult(item) ? "✗" : "✓";
				const title = item.title ?? `Task ${item.index + 1}`;
				lines.push(`${icon} ${title}`);
				if (expanded && item.exitCode !== -1) {
					const toolCalls = getToolCalls(item.messages)
						.slice(0, 8)
						.map((call) => `  → ${call.name}`);
					lines.push(...toolCalls);
					const output = getResultOutput(item).split("\n").slice(0, 12).join("\n");
					if (output) lines.push(output);
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
