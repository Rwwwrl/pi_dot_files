/**
 * Modes Extension
 *
 * Claude Code-style modes for pi:
 * - normal: no intention wrapper; allowlisted/research commands run directly; changes require approval
 * - research: read-only code understanding and review through the research gate
 * - plan: research-capable implementation planning with persisted plan artifacts
 * - brainstorming: research-capable brainstorming and feature-shaping
 * - auto: execution mode protected by the execution gate
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAutoModePrompt } from "./auto/prompts.ts";
import { buildBrainstormingModePrompt } from "./brainstorming/prompts.ts";
import { reviewToolCallWithExecutionGate, reviewToolCallWithResearchGate } from "./ai-reviewer.ts";
import {
	classifyExecutionBashCommand,
	classifyExecutionToolCall,
	classifyNormalBashCommand,
	classifyResearchBashCommand,
	classifyResearchToolCall,
	isGitPushForceWithLeaseCommand,
} from "./policies.ts";
import { approveExecutionForcePushWithLease, approveNormalBashCommand, approveNormalToolCall } from "./views.ts";
import { buildNormalModePrompt } from "./normal/prompts.ts";
import { savePlanArtifact, shouldPersistPlanText } from "./repositories.ts";
import { buildPlanExecuteMessage } from "./services.ts";
import { buildPlanModePrompt } from "./plan/prompts.ts";
import { registerPlanQuestionTool } from "./plan/tools.ts";
import { buildResearchModePrompt } from "./research/prompts.ts";
import { setCurrentMode, type Mode } from "./state.ts";

const MODE_ORDER: Mode[] = ["normal", "research", "plan", "brainstorming", "auto"];
const READ_ONLY_MODE_TOOL_ALLOWLIST = new Set([
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"plan_question",
	"question",
	"questionnaire",
	"ask_question",
	"web_research",
	"web_fetch",
	"subagents",
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

function modeStatusColor(mode: Mode): "success" | "muted" | "warning" {
	return mode === "auto" ? "success" : mode === "normal" ? "muted" : "warning";
}

async function reviewResearchToolCall(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	reason: string,
): Promise<{ allow: boolean; reason: string }> {
	return reviewToolCallWithResearchGate(ctx, toolName, input, reason);
}

function canUseSubagents(mode: Mode): boolean {
	return mode === "research" || mode === "plan" || mode === "brainstorming";
}

export default function modesExtension(pi: ExtensionAPI): void {
	let currentMode: Mode = "normal";
	let activePlanFile: string | undefined;
	let baselineActiveTools: Set<string> | undefined;

	pi.registerFlag("research", {
		description: "Start in research mode (read-only code understanding)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("plan", {
		description: "Start in plan mode (research-capable ordered planning)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("brainstorming", {
		description: "Start in brainstorming mode (research-capable brainstorming)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("automode", {
		description: "Start in auto mode (execution gate)",
		type: "boolean",
		default: false,
	});

	registerPlanQuestionTool(pi);

	function getBaselineActiveTools(): Set<string> {
		baselineActiveTools ??= new Set(pi.getActiveTools());
		return baselineActiveTools;
	}

	function getAvailableTools(): string[] {
		const baseline = getBaselineActiveTools();
		const modeAllowlist =
			currentMode === "research" || currentMode === "plan" || currentMode === "brainstorming"
				? READ_ONLY_MODE_TOOL_ALLOWLIST
				: undefined;
		return pi
			.getAllTools()
			.map((tool) => tool.name)
			.filter((tool) => {
				if (!baseline.has(tool)) return false;
				if (tool === "subagents" && !canUseSubagents(currentMode)) return false;
				return !modeAllowlist || modeAllowlist.has(tool);
			});
	}

	function restoreBaselineTools(toolNames: string[]): void {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		// Preserve the session's original active-tool baseline, but drop tools that no longer exist after reloads.
		baselineActiveTools = new Set(toolNames.filter((toolName) => available.has(toolName)));
		// Allow this extension's own tools to become available in existing sessions after /reload without enabling every new tool.
		if (available.has("plan_question")) baselineActiveTools.add("plan_question");
		if (available.has("subagents")) baselineActiveTools.add("subagents");
	}

	function applyTools(): void {
		pi.setActiveTools(getAvailableTools());
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("mode", ctx.ui.theme.fg(modeStatusColor(currentMode), `mode: ${currentMode}`));
	}

	function persistState(): void {
		pi.appendEntry("modes", {
			mode: currentMode,
			planFile: activePlanFile,
			baselineTools: [...getBaselineActiveTools()],
		});
	}

	function setMode(mode: Mode, ctx: ExtensionContext, options: { persist: boolean }): void {
		currentMode = mode;
		setCurrentMode(mode);
		// Keep the active plan file when switching modes so brainstorming/plan can refine it; research leaves it unchanged.

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
		description: "Show or switch mode: normal, research, plan, brainstorming, auto",
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
		description: "Switch to normal mode (allowlisted/research commands direct; changes require approval)",
		handler: async (_args, ctx) => setMode("normal", ctx, { persist: true }),
	});

	pi.registerCommand("research", {
		description: "Switch to research mode (read-only code understanding)",
		handler: async (_args, ctx) => setMode("research", ctx, { persist: true }),
	});

	pi.registerCommand("plan", {
		description: "Switch to plan mode (research-capable ordered planning)",
		handler: async (_args, ctx) => setMode("plan", ctx, { persist: true }),
	});

	pi.registerCommand("brainstorming", {
		description: "Switch to brainstorming mode (research-capable brainstorming)",
		handler: async (_args, ctx) => setMode("brainstorming", ctx, { persist: true }),
	});

	pi.registerCommand("auto", {
		description: "Switch to auto mode (execution gate)",
		handler: async (_args, ctx) => setMode("auto", ctx, { persist: true }),
	});

	pi.registerShortcut("shift+tab", {
		description: "Cycle mode: normal → research → plan → brainstorming → auto",
		handler: async (ctx) => cycleMode(ctx),
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		if (currentMode === "auto") {
			const classification = classifyExecutionToolCall(event.toolName, input, ctx.cwd);
			if (classification.decision === "allow") return undefined;
			if (classification.decision === "deny") {
				return { block: true, reason: `execution gate blocked ${event.toolName}: ${classification.reason}` };
			}

			const command = event.toolName === "bash" && typeof input.command === "string" ? input.command : "";
			if (isGitPushForceWithLeaseCommand(command)) {
				const approved = await approveExecutionForcePushWithLease(ctx, command);
				if (approved) return undefined;
				return { block: true, reason: `execution gate requires explicit user approval before git push --force-with-lease.\nCommand: ${command}` };
			}

			const review = await reviewToolCallWithExecutionGate(ctx, event.toolName, input, classification.reason);
			if (review.allow) return undefined;
			return { block: true, reason: `execution-gate safety review blocked ${event.toolName}: ${review.reason}` };
		}

		if (currentMode === "normal") {
			if (event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				const classification = classifyNormalBashCommand(command);
				if (classification.decision === "allow") return undefined;
				if (classification.decision === "deny") {
					return { block: true, reason: `normal mode blocked shell command: ${classification.reason}\nCommand: ${command}` };
				}

				const approved = await approveNormalBashCommand(ctx, command);
				if (approved) return undefined;
				return {
					block: true,
					reason: `normal mode requires explicit user approval for this shell command.\nCommand: ${command}`,
				};
			}

			if (event.toolName === "edit" || event.toolName === "write") {
				const approved = await approveNormalToolCall(ctx, event.toolName, input);
				if (approved) return undefined;
				return { block: true, reason: `normal mode requires user approval before ${event.toolName}.` };
			}

			const classification = classifyResearchToolCall(event.toolName, input, ctx.cwd);
			if (classification.decision === "allow") return undefined;
			if (classification.decision === "deny") {
				return { block: true, reason: `normal mode blocked ${event.toolName}: ${classification.reason}` };
			}

			const approved = await approveNormalToolCall(ctx, event.toolName, input);
			if (approved) return undefined;
			return { block: true, reason: `normal mode requires user approval before ${event.toolName}: ${classification.reason}` };
		}

		const classification = classifyResearchToolCall(event.toolName, input, ctx.cwd);
		if (classification.decision === "allow") return undefined;
		if (classification.decision === "deny") {
			return { block: true, reason: `${currentMode} mode blocked ${event.toolName}: ${classification.reason}` };
		}

		const review = await reviewResearchToolCall(ctx, event.toolName, input, classification.reason);
		if (review.allow) return undefined;
		return { block: true, reason: `${currentMode} research-gate review blocked ${event.toolName}: ${review.reason}` };
	});

	pi.on("user_bash", async (event, ctx) => {
		if (currentMode === "auto") {
			const classification = classifyExecutionBashCommand(event.command);
			if (classification.decision === "allow") return undefined;
			if (classification.decision === "deny") {
				return {
					result: {
						output: `execution gate blocked shell command: ${classification.reason}\nCommand: ${event.command}`,
						exitCode: 1,
						cancelled: false,
						truncated: false,
					},
				};
			}

			if (isGitPushForceWithLeaseCommand(event.command)) {
				const approved = await approveExecutionForcePushWithLease(ctx, event.command);
				if (approved) return undefined;
				return {
					result: {
						output: `execution gate requires explicit user approval before git push --force-with-lease.\nCommand: ${event.command}`,
						exitCode: 1,
						cancelled: false,
						truncated: false,
					},
				};
			}

			const review = await reviewToolCallWithExecutionGate(ctx, "bash", { command: event.command }, classification.reason);
			if (review.allow) return undefined;
			return {
				result: {
					output: `execution-gate safety review blocked shell command: ${review.reason}\nCommand: ${event.command}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		if (currentMode === "normal") {
			const classification = classifyNormalBashCommand(event.command);
			if (classification.decision === "allow") return undefined;
			if (classification.decision === "deny") {
				return {
					result: {
						output: `normal mode blocked shell command: ${classification.reason}\nCommand: ${event.command}`,
						exitCode: 1,
						cancelled: false,
						truncated: false,
					},
				};
			}

			const approved = await approveNormalBashCommand(ctx, event.command);
			if (approved) return undefined;
			return {
				result: {
					output: `normal mode requires explicit user approval for this shell command.\nCommand: ${event.command}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		const classification = classifyResearchBashCommand(event.command);
		if (classification.decision === "allow") return undefined;
		if (classification.decision === "deny") {
			return {
				result: {
					output: `${currentMode} mode blocked shell command: ${classification.reason}\nCommand: ${event.command}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		const review = await reviewResearchToolCall(ctx, "bash", { command: event.command }, classification.reason);
		if (review.allow) return undefined;
		return {
			result: {
				output: `${currentMode} research-gate review blocked shell command: ${review.reason}\nCommand: ${event.command}`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
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

		if (currentMode === "research") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildResearchModePrompt()}` };
		}

		if (currentMode === "brainstorming") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildBrainstormingModePrompt(activePlanFile)}` };
		}

		if (currentMode === "plan") {
			return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt(activePlanFile)}` };
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${buildAutoModePrompt()}` };
	});

	pi.on("agent_end", async (event, ctx) => {
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
			"Switch to brainstorming mode",
		]);

		if (!choice) return;

		if (choice === "Refine the plan") {
			ctx.ui.setEditorText(`Refine ${activePlanFile ? `the plan in ${activePlanFile}` : "the current plan"}: `);
			return;
		}

		if (choice?.startsWith("Execute")) {
			setMode("auto", ctx, { persist: true });

			pi.sendMessage(
				{ customType: "mode-plan-execute", content: buildPlanExecuteMessage(activePlanFile), display: false },
				{ triggerTurn: true },
			);
		} else if (choice === "Switch to brainstorming mode") {
			setMode("brainstorming", ctx, { persist: true });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getBranch();
		const modeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "modes")
			.pop() as
			| { data?: { mode?: Mode; planFile?: string; baselineTools?: string[] } }
			| undefined;

		if (Array.isArray(modeEntry?.data?.baselineTools)) {
			restoreBaselineTools(modeEntry.data.baselineTools);
		} else {
			baselineActiveTools = new Set(pi.getActiveTools());
		}

		if (modeEntry?.data?.mode && MODE_ORDER.includes(modeEntry.data.mode)) {
			currentMode = modeEntry.data.mode;
			activePlanFile = modeEntry.data.planFile;
		}

		if (pi.getFlag("research") === true) currentMode = "research";
		if (pi.getFlag("plan") === true) currentMode = "plan";
		if (pi.getFlag("brainstorming") === true) currentMode = "brainstorming";
		if (pi.getFlag("automode") === true) currentMode = "auto";
		setCurrentMode(currentMode);

		applyTools();
		updateStatus(ctx);
	});
}
