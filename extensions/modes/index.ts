/**
 * Modes Extension
 *
 * Claude Code-style modes for pi:
 * - normal: no intention wrapper; allowlisted/research commands run directly; changes require approval
 * - inline: explicit cursor/request-context micro edits; changes require approval
 * - research: read-only code understanding and review through the research gate
 * - plan: research-capable implementation planning with persisted plan artifacts
 * - brainstorming: research-capable brainstorming and feature-shaping
 * - auto: execution mode protected by the execution gate
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildModesOverlayPrompt } from "./prompts.ts";
import { savePlanArtifact, shouldPersistPlanText } from "./repositories.ts";
import { buildPlanExecuteMessage, handleModeToolCall, handleModeUserBash, isTrustedSubagentsTool } from "./services.ts";
import { registerQuestionTool } from "./tools.ts";
import { colorizeMode } from "./colors.ts";
import { setCurrentMode, type Mode } from "./state.ts";
import { getRegisteredMcpToolNames, isRegisteredMcpTool } from "../mcp/registry.ts";

const MODE_ORDER: Mode[] = ["normal", "research", "plan", "brainstorming", "auto", "inline"];
const EXECUTE_PLAN_CHOICE = "Execute the plan in auto mode";
const STAY_IN_PLAN_CHOICE = "Stay in plan mode";
const REFINE_PLAN_CHOICE = "Refine the plan";
const SWITCH_TO_BRAINSTORMING_CHOICE = "Switch to brainstorming mode";
const INLINE_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "edit", "write"] as const;
const RESEARCH_TOOL_NAMES = [
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"question_tool",
	"question",
	"questionnaire",
	"ask_question",
	"web_research",
	"web_fetch",
	"subagents",
] as const;
const MODE_TOOL_NAMES: Partial<Record<Mode, ReadonlySet<string>>> = {
	inline: new Set(INLINE_TOOL_NAMES),
	research: new Set(RESEARCH_TOOL_NAMES),
	plan: new Set(RESEARCH_TOOL_NAMES),
	brainstorming: new Set(RESEARCH_TOOL_NAMES),
};
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

function canUseSubagents(mode: Mode): boolean {
	return mode === "research" || mode === "plan" || mode === "brainstorming";
}

export default function modesExtension(pi: ExtensionAPI): void {
	let currentMode: Mode = "normal";
	let executionMode = false;
	let activePlanFile: string | undefined;
	let baselineActiveTools: Set<string> | undefined;

	pi.registerFlag("research", {
		description: "Start in research mode (read-only code understanding)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("inline", {
		description: "Start in inline mode (explicit-context micro edits; changes require approval)",
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

	registerQuestionTool(pi);

	function getBaselineActiveTools(): Set<string> {
		baselineActiveTools ??= new Set(pi.getActiveTools());
		return baselineActiveTools;
	}

	function getAvailableTools(): string[] {
		const baseline = getBaselineActiveTools();
		const modeToolNames = MODE_TOOL_NAMES[currentMode];
		return pi
			.getAllTools()
			.map((tool) => tool.name)
			.filter((tool) => {
				if (!baseline.has(tool) && !isRegisteredMcpTool(tool)) return false;
				if (modeToolNames) return modeToolNames.has(tool);
				if (tool === "subagents" && !canUseSubagents(currentMode)) return false;
				return true;
			});
	}

	function restoreBaselineTools(toolNames: string[]): void {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		// Preserve the session's original active-tool baseline, but drop tools that no longer exist after reloads.
		baselineActiveTools = new Set(toolNames.filter((toolName) => available.has(toolName)));
		// Allow this extension's own tools to become available in existing sessions after /reload without enabling every new tool.
		if (available.has("question_tool")) baselineActiveTools.add("question_tool");
		if (available.has("subagents")) baselineActiveTools.add("subagents");
		for (const toolName of getRegisteredMcpToolNames()) {
			if (available.has(toolName)) baselineActiveTools.add(toolName);
		}
	}

	function applyTools(): void {
		pi.setActiveTools(getAvailableTools());
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("mode", colorizeMode(currentMode, `mode: ${currentMode}`));
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
		setCurrentMode(mode);
		if (mode !== "auto") {
			executionMode = false;
		}
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

	function executeActivePlanInAutoMode(ctx: ExtensionContext): void {
		setMode("auto", ctx, { persist: false });
		executionMode = true;
		persistState();

		const executionMessage = buildPlanExecuteMessage(activePlanFile);
		const sendWhenIdle = (): void => {
			if (!ctx.isIdle()) {
				setTimeout(sendWhenIdle, 25);
				return;
			}

			pi.sendUserMessage(executionMessage);
		};

		// Start a fresh user-message turn after the plan-mode run fully settles. A custom
		// message with triggerTurn continues with the previous system prompt, leaving the
		// model under the stale read-only plan contract even though the statusline is auto.
		setTimeout(sendWhenIdle, 0);
	}

	pi.registerCommand("mode", {
		description: "Show or switch mode: normal, research, plan, brainstorming, auto, inline",
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

	pi.registerCommand("inline", {
		description: "Switch to inline mode (explicit-context micro edits; changes require approval)",
		handler: async (_args, ctx) => setMode("inline", ctx, { persist: true }),
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
		description: "Cycle mode: normal → research → plan → brainstorming → auto → inline",
		handler: async (ctx) => cycleMode(ctx),
	});

	pi.on("tool_call", async (event, ctx) => {
		const subagentsTool = pi.getAllTools().find((tool) => tool.name === "subagents");
		const trustedReadOnlyTools = isTrustedSubagentsTool(subagentsTool) ? new Set(["subagents"]) : undefined;
		return handleModeToolCall(currentMode, event, ctx, { trustedReadOnlyTools });
	});

	pi.on("user_bash", async (event, ctx) => {
		return handleModeUserBash(currentMode, event, ctx);
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
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildModesOverlayPrompt({ mode: executionMode ? "auto" : currentMode, activePlanFile })}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && currentMode === "auto") {
			executionMode = false;
			persistState();
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
			EXECUTE_PLAN_CHOICE,
			STAY_IN_PLAN_CHOICE,
			REFINE_PLAN_CHOICE,
			SWITCH_TO_BRAINSTORMING_CHOICE,
		]);

		if (!choice) return;

		if (choice === REFINE_PLAN_CHOICE) {
			ctx.ui.setEditorText(`Refine ${activePlanFile ? `the plan in ${activePlanFile}` : "the current plan"}: `);
			return;
		}

		if (choice === EXECUTE_PLAN_CHOICE) {
			executeActivePlanInAutoMode(ctx);
		} else if (choice === SWITCH_TO_BRAINSTORMING_CHOICE) {
			setMode("brainstorming", ctx, { persist: true });
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
			restoreBaselineTools(modeEntry.data.baselineTools);
		} else {
			baselineActiveTools = new Set(pi.getActiveTools());
		}

		if (modeEntry?.data?.mode && MODE_ORDER.includes(modeEntry.data.mode)) {
			currentMode = modeEntry.data.mode;
			executionMode = modeEntry.data.executing ?? false;
			activePlanFile = modeEntry.data.planFile;
		}

		if (pi.getFlag("research") === true) currentMode = "research";
		if (pi.getFlag("inline") === true) currentMode = "inline";
		if (pi.getFlag("plan") === true) currentMode = "plan";
		if (pi.getFlag("brainstorming") === true) currentMode = "brainstorming";
		if (pi.getFlag("automode") === true) currentMode = "auto";
		if (currentMode !== "auto") executionMode = false;
		setCurrentMode(currentMode);

		applyTools();
		updateStatus(ctx);
	});
}
