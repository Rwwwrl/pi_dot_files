import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	classifyExecutionBashCommand,
	classifyExecutionToolCall,
	classifyNormalBashCommand,
	classifyResearchBashCommand,
	classifyResearchToolCall,
	isGitPushForceWithLeaseCommand,
} from "./policies.ts";
import type { Mode } from "./state.ts";
import { approveExecutionForcePushWithLease, approveNormalToolCall } from "./views.ts";

export function buildPlanExecuteMessage(activePlanFile?: string): string {
	if (activePlanFile) {
		return `Read ${activePlanFile}, then execute its implementation steps in auto mode. Follow the plan's verification guidance and keep changes small and reviewable.`;
	}
	return "Execute the latest saved plan in auto mode. Read the plan first, follow its verification guidance, and keep changes small and reviewable.";
}

type ResearchMode = "research" | "plan" | "brainstorming";
type ApprovalMode = "normal" | "inline";
type GateReviewSource = "tool_call" | "user_bash";

export interface ModeToolCallOptions {
	trustedReadOnlyTools?: ReadonlySet<string>;
}

function isResearchMode(mode: Mode): mode is ResearchMode {
	return mode === "research" || mode === "plan" || mode === "brainstorming";
}

export function isTrustedSubagentsTool(tool: {
	name: string;
	sourceInfo: { source: string; scope: string };
} | undefined): boolean {
	return tool?.name === "subagents" && (tool.sourceInfo.source === "sdk" || tool.sourceInfo.scope === "user");
}

function blockUserBash(output: string): UserBashEventResult {
	return {
		result: {
			output,
			exitCode: 1,
			cancelled: false,
			truncated: false,
		},
	};
}

async function reviewModeToolCall(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	reason: string,
	mode: Mode,
	source: GateReviewSource,
): Promise<{ allow: boolean; reason: string }> {
	if (!ctx.model) return { allow: false, reason: "No model is selected, so Autoreviewer cannot run." };
	const { reviewToolCallWithAutoReviewer } = await import("./ai-reviewer.ts");
	return reviewToolCallWithAutoReviewer(ctx, toolName, input, reason, { source, mode });
}

async function handleAutoToolCall(
	toolName: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const classification = classifyExecutionToolCall(toolName, input, ctx.cwd);
	if (classification.decision === "allow") return undefined;
	if (classification.decision === "deny") {
		return { block: true, reason: `execution gate blocked ${toolName}: ${classification.reason}` };
	}

	const command = toolName === "bash" && typeof input.command === "string" ? input.command : "";
	if (isGitPushForceWithLeaseCommand(command)) {
		const approved = await approveExecutionForcePushWithLease(ctx, command);
		if (approved) return undefined;
		return { block: true, reason: `execution gate requires explicit user approval before git push --force-with-lease.\nCommand: ${command}` };
	}

	const review = await reviewModeToolCall(ctx, toolName, input, classification.reason, "auto", "tool_call");
	if (review.allow) return undefined;
	return { block: true, reason: `autoreviewer blocked ${toolName}: ${review.reason}` };
}

async function handleNormalToolCall(
	toolName: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (toolName === "bash") return handleApprovalModeBashToolCall("normal", input, ctx);

	if (toolName === "edit" || toolName === "write") {
		const approved = await approveNormalToolCall(ctx, toolName, input);
		if (approved) return undefined;
		return { block: true, reason: `normal mode requires user approval before ${toolName}.` };
	}

	return handleApprovalModeResearchToolCall("normal", toolName, input, ctx);
}

async function handleInlineToolCall(
	toolName: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (toolName === "bash") return handleApprovalModeBashToolCall("inline", input, ctx);

	if (toolName === "edit" || toolName === "write") {
		const approved = await approveNormalToolCall(ctx, toolName, input);
		if (approved) return undefined;
		return { block: true, reason: `inline mode requires user approval before ${toolName}.` };
	}

	return handleApprovalModeResearchToolCall("inline", toolName, input, ctx);
}

async function handleApprovalModeBashToolCall(
	mode: ApprovalMode,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const command = typeof input.command === "string" ? input.command : "";
	const classification = classifyNormalBashCommand(command);
	if (classification.decision === "allow") return undefined;
	if (classification.decision === "deny") {
		return { block: true, reason: `${mode} mode blocked shell command: ${classification.reason}\nCommand: ${command}` };
	}

	const review = await reviewModeToolCall(ctx, "bash", { command }, classification.reason, mode, "tool_call");
	if (review.allow) return undefined;
	return {
		block: true,
		reason: `${mode} mode autoreviewer blocked shell command: ${review.reason}\nCommand: ${command}`,
	};
}

async function handleApprovalModeResearchToolCall(
	mode: ApprovalMode,
	toolName: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const classification = classifyResearchToolCall(toolName, input, ctx.cwd);
	if (classification.decision === "allow") return undefined;
	if (classification.decision === "deny") {
		return { block: true, reason: `${mode} mode blocked ${toolName}: ${classification.reason}` };
	}

	const review = await reviewModeToolCall(ctx, toolName, input, classification.reason, mode, "tool_call");
	if (review.allow) return undefined;
	return { block: true, reason: `${mode} mode autoreviewer blocked ${toolName}: ${review.reason}` };
}

async function handleResearchModeToolCall(
	mode: ResearchMode,
	toolName: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const classification = classifyResearchToolCall(toolName, input, ctx.cwd);
	if (classification.decision === "allow") return undefined;
	if (classification.decision === "deny") {
		return { block: true, reason: `${mode} mode blocked ${toolName}: ${classification.reason}` };
	}

	const review = await reviewModeToolCall(ctx, toolName, input, classification.reason, mode, "tool_call");
	if (review.allow) return undefined;
	return { block: true, reason: `${mode} mode autoreviewer blocked ${toolName}: ${review.reason}` };
}

async function handleAutoUserBash(command: string, ctx: ExtensionContext): Promise<UserBashEventResult | undefined> {
	const classification = classifyExecutionBashCommand(command);
	if (classification.decision === "allow") return undefined;
	if (classification.decision === "deny") {
		return blockUserBash(`execution gate blocked shell command: ${classification.reason}\nCommand: ${command}`);
	}

	if (isGitPushForceWithLeaseCommand(command)) {
		const approved = await approveExecutionForcePushWithLease(ctx, command);
		if (approved) return undefined;
		return blockUserBash(`execution gate requires explicit user approval before git push --force-with-lease.\nCommand: ${command}`);
	}

	const review = await reviewModeToolCall(ctx, "bash", { command }, classification.reason, "auto", "user_bash");
	if (review.allow) return undefined;
	return blockUserBash(`autoreviewer blocked shell command: ${review.reason}\nCommand: ${command}`);
}

async function handleNormalUserBash(command: string, ctx: ExtensionContext): Promise<UserBashEventResult | undefined> {
	return handleApprovalModeUserBash("normal", command, ctx);
}

async function handleInlineUserBash(command: string, ctx: ExtensionContext): Promise<UserBashEventResult | undefined> {
	return handleApprovalModeUserBash("inline", command, ctx);
}

async function handleApprovalModeUserBash(
	mode: ApprovalMode,
	command: string,
	ctx: ExtensionContext,
): Promise<UserBashEventResult | undefined> {
	const classification = classifyNormalBashCommand(command);
	if (classification.decision === "allow") return undefined;
	if (classification.decision === "deny") {
		return blockUserBash(`${mode} mode blocked shell command: ${classification.reason}\nCommand: ${command}`);
	}

	const review = await reviewModeToolCall(ctx, "bash", { command }, classification.reason, mode, "user_bash");
	if (review.allow) return undefined;
	return blockUserBash(`${mode} mode autoreviewer blocked shell command: ${review.reason}\nCommand: ${command}`);
}

async function handleResearchModeUserBash(
	mode: ResearchMode,
	command: string,
	ctx: ExtensionContext,
): Promise<UserBashEventResult | undefined> {
	const classification = classifyResearchBashCommand(command);
	if (classification.decision === "allow") return undefined;
	if (classification.decision === "deny") {
		return blockUserBash(`${mode} mode blocked shell command: ${classification.reason}\nCommand: ${command}`);
	}

	const review = await reviewModeToolCall(ctx, "bash", { command }, classification.reason, mode, "user_bash");
	if (review.allow) return undefined;
	return blockUserBash(`${mode} mode autoreviewer blocked shell command: ${review.reason}\nCommand: ${command}`);
}

export async function handleModeToolCall(
	mode: Mode,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	options: ModeToolCallOptions = {},
): Promise<ToolCallEventResult | undefined> {
	if (isResearchMode(mode) && options.trustedReadOnlyTools?.has(event.toolName)) return undefined;

	const input = event.input as Record<string, unknown>;

	switch (mode) {
		case "auto":
			return handleAutoToolCall(event.toolName, input, ctx);
		case "normal":
			return handleNormalToolCall(event.toolName, input, ctx);
		case "inline":
			return handleInlineToolCall(event.toolName, input, ctx);
		case "research":
			return handleResearchModeToolCall("research", event.toolName, input, ctx);
		case "plan":
			return handleResearchModeToolCall("plan", event.toolName, input, ctx);
		case "brainstorming":
			return handleResearchModeToolCall("brainstorming", event.toolName, input, ctx);
	}
}

export async function handleModeUserBash(
	mode: Mode,
	event: UserBashEvent,
	ctx: ExtensionContext,
): Promise<UserBashEventResult | undefined> {
	switch (mode) {
		case "auto":
			return handleAutoUserBash(event.command, ctx);
		case "normal":
			return handleNormalUserBash(event.command, ctx);
		case "inline":
			return handleInlineUserBash(event.command, ctx);
		case "research":
			return handleResearchModeUserBash("research", event.command, ctx);
		case "plan":
			return handleResearchModeUserBash("plan", event.command, ctx);
		case "brainstorming":
			return handleResearchModeUserBash("brainstorming", event.command, ctx);
	}
}
