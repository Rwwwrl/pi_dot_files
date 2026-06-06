/**
 * Modes Extension
 *
 * Claude Code-style modes for pi:
 * - normal: safe work with approval required for changes
 * - plan: read-only ordered implementation planning
 * - grooming: read-only brainstorming and feature-shaping
 * - auto: full tool access
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyBashCommand, classifyToolCall, isSafeCommand } from "./auto/safety.ts";
import { reviewToolCallWithAgent } from "./auto/review.ts";
import { buildAutoModePrompt } from "./auto/prompts.ts";
import { buildGroomingModePrompt } from "./grooming/prompts.ts";
import { approveNormalBashCommand, approveNormalToolCall } from "./normal/approval.ts";
import { buildNormalModePrompt } from "./normal/prompts.ts";
import { savePlanArtifact, shouldPersistPlanText } from "./plan/artifacts.ts";
import { buildPlanExecuteMessage, buildPlanExecutionPrompt } from "./plan/execution.ts";
import { buildPlanModePrompt } from "./plan/prompts.ts";
import { registerPlanQuestionTool } from "./plan/tools.ts";

type Mode = "normal" | "plan" | "grooming" | "auto";

const MODE_ORDER: Mode[] = ["normal", "plan", "grooming", "auto"];
const READ_ONLY_TOOLS = new Set([
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"plan_question",
	"questionnaire",
	"question",
	"ask_question",
]);
const HIDDEN_CUSTOM_MESSAGE_TYPES = new Set([
	// Compatibility: hide context-injection messages from older versions of this extension.
	"plan-mode-context",
	"plan-execution-context",
]);

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getMessageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is TextContent => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join("\n");
}

function getLastUserText(messages: readonly AgentMessage[]): string {
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
	return lastUser ? getMessageText(lastUser) : "";
}

function normalizeMode(value: string): Mode | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "automode") return "auto";
	if (MODE_ORDER.includes(normalized as Mode)) return normalized as Mode;
	return undefined;
}

function nextMode(mode: Mode): Mode {
	const index = MODE_ORDER.indexOf(mode);
	return MODE_ORDER[(index + 1) % MODE_ORDER.length];
}

function isReadOnlyMode(mode: Mode): boolean {
	return mode === "plan" || mode === "grooming";
}

function modeStatusColor(mode: Mode): "success" | "muted" | "warning" {
	return mode === "auto" ? "success" : mode === "normal" ? "muted" : "warning";
}

export default function modesExtension(pi: ExtensionAPI): void {
	let currentMode: Mode = "normal";
	let executionMode = false;
	let activePlanFile: string | undefined;
	let baselineActiveTools: Set<string> | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only ordered planning)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("grooming", {
		description: "Start in grooming mode (read-only brainstorming)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("automode", {
		description: "Start in auto mode (full tool access)",
		type: "boolean",
		default: false,
	});

	registerPlanQuestionTool(pi);

	function getBaselineActiveTools(): Set<string> {
		baselineActiveTools ??= new Set(pi.getActiveTools());
		return baselineActiveTools;
	}

	function getAvailableTools(allowedTools?: Set<string>): string[] {
		const baseline = getBaselineActiveTools();
		return pi
			.getAllTools()
			.map((tool) => tool.name)
			.filter((tool) => baseline.has(tool) && (!allowedTools || allowedTools.has(tool)));
	}

	function applyTools(): void {
		pi.setActiveTools(isReadOnlyMode(currentMode) ? getAvailableTools(READ_ONLY_TOOLS) : getAvailableTools());
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("mode", ctx.ui.theme.fg(modeStatusColor(currentMode), `mode: ${currentMode}`));
	}

	function persistState(): void {
		pi.appendEntry("modes", {
			mode: currentMode,
			executing: executionMode,
			planFile: activePlanFile,
			baselineTools: [...getBaselineActiveTools()],
		});
	}

	function setMode(mode: Mode, ctx: ExtensionContext, options: { persist: boolean }): void {
		currentMode = mode;

		if (mode !== "auto") {
			executionMode = false;
		}
		// Keep the active plan file when switching modes so grooming/plan can refine it.

		applyTools();
		updateStatus(ctx);

		if (options.persist) {
			persistState();
		}
	}

	function cycleMode(ctx: ExtensionContext): void {
		setMode(nextMode(currentMode), ctx, { persist: true });
	}

	pi.registerCommand("mode", {
		description: "Show or switch mode: normal, plan, grooming, auto",
		handler: async (args, ctx) => {
			const requestedMode = normalizeMode(args);
			if (!requestedMode) {
				ctx.ui.notify(`Current mode: ${currentMode}\nAvailable modes: ${MODE_ORDER.join(", ")}`, "info");
				return;
			}
			setMode(requestedMode, ctx, { persist: true });
		},
	});

	pi.registerCommand("normal", {
		description: "Switch to normal mode (safe commands direct; changes require approval)",
		handler: async (_args, ctx) => setMode("normal", ctx, { persist: true }),
	});

	pi.registerCommand("plan", {
		description: "Switch to plan mode (read-only ordered planning)",
		handler: async (_args, ctx) => setMode("plan", ctx, { persist: true }),
	});

	pi.registerCommand("grooming", {
		description: "Switch to grooming mode (read-only brainstorming)",
		handler: async (_args, ctx) => setMode("grooming", ctx, { persist: true }),
	});

	pi.registerCommand("auto", {
		description: "Switch to auto mode (full tool access)",
		handler: async (_args, ctx) => setMode("auto", ctx, { persist: true }),
	});

	pi.registerShortcut("shift+tab", {
		description: "Cycle mode: normal → plan → grooming → auto",
		handler: async (ctx) => cycleMode(ctx),
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const classification = classifyToolCall(event.toolName, input, ctx.cwd);

		if (currentMode === "auto") {
			if (classification.decision === "allow") return undefined;
			if (classification.decision === "deny") {
				return { block: true, reason: `Automode blocked ${event.toolName}: ${classification.reason}` };
			}

			const review = await reviewToolCallWithAgent(ctx, event.toolName, input, classification.reason);
			if (review.allow) return undefined;
			return { block: true, reason: `Automode safety review blocked ${event.toolName}: ${review.reason}` };
		}

		if (currentMode === "normal") {
			if (event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				if (!command.trim() || isSafeCommand(command)) return undefined;

				const approved = await approveNormalBashCommand(ctx, command);
				if (approved) return undefined;
				return {
					block: true,
					reason: `normal mode requires explicit user approval for unsafe shell commands.\nCommand: ${command}`,
				};
			}

			if (READ_ONLY_TOOLS.has(event.toolName) && classification.decision !== "allow") {
				const approved = await approveNormalToolCall(ctx, event.toolName, input);
				if (approved) return undefined;
				return {
					block: true,
					reason: `normal mode requires user approval before ${event.toolName}: ${classification.reason}`,
				};
			}

			if (!READ_ONLY_TOOLS.has(event.toolName)) {
				const approved = await approveNormalToolCall(ctx, event.toolName, input);
				if (approved) return undefined;
				return { block: true, reason: `normal mode requires user approval before running ${event.toolName}.` };
			}

			return undefined;
		}

		if (!READ_ONLY_TOOLS.has(event.toolName)) {
			return { block: true, reason: `${currentMode} mode is read-only. Switch to auto mode to use ${event.toolName}.` };
		}

		if (classification.decision !== "allow") {
			return { block: true, reason: `${currentMode} mode blocked ${event.toolName}: ${classification.reason}` };
		}
		return undefined;
	});

	pi.on("user_bash", async (event, ctx) => {
		const classification = classifyBashCommand(event.command);
		if (classification.decision === "allow") return undefined;

		if (currentMode === "normal") {
			const approved = await approveNormalBashCommand(ctx, event.command);
			if (approved) return undefined;

			return {
				result: {
					output: `normal mode requires explicit user approval for unsafe shell commands.\nCommand: ${event.command}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		if (currentMode !== "auto" || classification.decision === "deny") {
			return {
				result: {
					output: `${currentMode} mode blocked shell command: ${classification.reason}\nCommand: ${event.command}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		return undefined;
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const customMessage = message as AgentMessage & { customType?: string };
				return !HIDDEN_CUSTOM_MESSAGE_TYPES.has(customMessage.customType ?? "");
			}),
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (currentMode === "normal") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildNormalModePrompt()}` };
		}

		if (currentMode === "grooming") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildGroomingModePrompt(activePlanFile)}` };
		}

		if (currentMode === "plan") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt(activePlanFile)}` };
		}

		if (executionMode) {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanExecutionPrompt(activePlanFile)}` };
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${buildAutoModePrompt()}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode) {
			executionMode = false;
			setMode("normal", ctx, { persist: true });
			return;
		}

		if (currentMode !== "plan") return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const planText = lastAssistant ? getTextContent(lastAssistant) : "";
		const hasCompletePlan = shouldPersistPlanText(planText);

		async function persistAndAnnouncePlan(): Promise<boolean> {
			try {
				const result = await savePlanArtifact(ctx, activePlanFile, planText, getLastUserText(event.messages));
				activePlanFile = result.file;
				persistState();
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Failed to save plan file: ${message}`, "error");
				persistState();
				return false;
			}
		}

		if (!hasCompletePlan) {
			persistState();
			return;
		}

		const saved = await persistAndAnnouncePlan();
		if (!saved || !ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan in auto mode",
			"Stay in plan mode",
			"Refine the plan",
			"Switch to grooming mode",
		]);

		if (!choice) return;

		if (choice === "Refine the plan") {
			return;
		}

		if (choice?.startsWith("Execute")) {
			currentMode = "auto";
			executionMode = true;
			applyTools();
			updateStatus(ctx);
			persistState();

			pi.sendMessage(
				{ customType: "mode-plan-execute", content: buildPlanExecuteMessage(activePlanFile), display: false },
				{ triggerTurn: true },
			);
		} else if (choice === "Switch to grooming mode") {
			setMode("grooming", ctx, { persist: true });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getBranch();
		const modeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "modes")
			.pop() as
			| { data?: { mode?: Mode; executing?: boolean; planFile?: string; baselineTools?: string[] } }
			| undefined;

		if (Array.isArray(modeEntry?.data?.baselineTools)) {
			baselineActiveTools = new Set(modeEntry.data.baselineTools);
		} else {
			baselineActiveTools = new Set(pi.getActiveTools());
		}

		if (modeEntry?.data?.mode && MODE_ORDER.includes(modeEntry.data.mode)) {
			currentMode = modeEntry.data.mode;
			executionMode = modeEntry.data.executing ?? false;
			activePlanFile = modeEntry.data.planFile;
		}

		if (pi.getFlag("plan") === true) currentMode = "plan";
		if (pi.getFlag("grooming") === true) currentMode = "grooming";
		if (pi.getFlag("automode") === true) currentMode = "auto";

		if (currentMode !== "auto") {
			executionMode = false;
		}

		applyTools();
		updateStatus(ctx);
	});
}
