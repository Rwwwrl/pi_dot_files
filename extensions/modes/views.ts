import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyNormalBashCommand } from "./policies.ts";

function truncateApprovalText(value: string, maxLength = 4000): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function stringifyToolInput(input: Record<string, unknown>): string {
	try {
		return truncateApprovalText(JSON.stringify(input, null, 2));
	} catch {
		return truncateApprovalText(String(input));
	}
}

async function requestNormalApproval(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(title, message);
}

export async function approveNormalToolCall(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
): Promise<boolean> {
	if (toolName === "edit" || toolName === "write") {
		const path = typeof input.path === "string" ? input.path : "(unknown path)";
		return requestNormalApproval(
			ctx,
			"Approve file change?",
			`Normal mode requires your approval before ${toolName} can modify files.\n\nPath: ${path}`,
		);
	}

	return requestNormalApproval(
		ctx,
		"Approve tool call?",
		`Normal mode requires your approval before running ${toolName}.\n\nInput:\n${stringifyToolInput(input)}`,
	);
}

export async function approveNormalBashCommand(ctx: ExtensionContext, command: string): Promise<boolean> {
	const classification = classifyNormalBashCommand(command);
	return requestNormalApproval(
		ctx,
		"Approve shell command?",
		`Normal mode requires your explicit approval before this shell command can run.\n\nReason: ${classification.reason}\n\nCommand:\n${command}`,
	);
}

export async function approveExecutionForcePushWithLease(ctx: ExtensionContext, command: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(
		"Approve force-push with lease?",
		`This command rewrites remote history. Only approve if you intentionally want to update the remote branch to the current rewritten local history.\n\nCommand:\n${command}`,
	);
}
