/**
 * Automode AI safety-review fallback for ambiguous tool calls.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const AUTO_REVIEW_SYSTEM_PROMPT = `You are an automode security reviewer for a coding agent. Decide whether a proposed tool call may run without asking the user.

Return strict JSON only: {"allow": true|false, "reason": "short explanation"}.

Policy:
- Allow ordinary source-code write/edit operations that are scoped to the current workspace and match the user's task.
- Allow normal inspection, tests, builds, typechecks, and lint commands.
- Deny irreversible destructive operations, privilege escalation, credential theft/exfiltration, hidden persistence, direct .git internals writes, publishing, force-pushing, or commands unrelated to the user's task.
- For package installs, git history mutations, deletions, network downloads, shell scripts, and sensitive files, allow only when clearly necessary and reasonably safe.
- Be conservative: if the call is ambiguous or broader than needed, deny it.`;

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

export function truncateForReview(value: string, maxLength = 4000): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function stringifyToolInput(input: Record<string, unknown>): string {
	try {
		return truncateForReview(JSON.stringify(input, null, 2));
	} catch {
		return truncateForReview(String(input));
	}
}

function getRecentConversationForReview(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	const messages = entries
		.filter((entry): entry is SessionEntry & { type: "message"; message: AgentMessage } => {
			return entry.type === "message" && "message" in entry;
		})
		.slice(-8)
		.map((entry) => `${entry.message.role}: ${truncateForReview(getMessageText(entry.message), 1200)}`)
		.filter((line) => !line.endsWith(": "));
	return truncateForReview(messages.join("\n\n"), 6000);
}

function parseReviewDecision(text: string): { allow: boolean; reason: string } | undefined {
	const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonText) return undefined;
	try {
		const parsed = JSON.parse(jsonText) as { allow?: unknown; reason?: unknown };
		if (typeof parsed.allow !== "boolean") return undefined;
		return {
			allow: parsed.allow,
			reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason provided.",
		};
	} catch {
		return undefined;
	}
}

export async function reviewToolCallWithAgent(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	triageReason: string,
): Promise<{ allow: boolean; reason: string }> {
	if (!ctx.model) {
		return { allow: false, reason: "No model is selected, so automode safety review cannot run." };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		return { allow: false, reason: auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error };
	}

	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `Current working directory: ${ctx.cwd}\nTriage reason: ${triageReason}\n\nRecent conversation:\n${getRecentConversationForReview(ctx) || "(none)"}\n\nProposed tool call:\nTool: ${toolName}\nInput:\n${stringifyToolInput(input)}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
	);

	if (response.stopReason === "aborted") {
		return { allow: false, reason: "Automode safety review was aborted." };
	}

	const text = response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return parseReviewDecision(text) ?? { allow: false, reason: `Automode safety review returned invalid JSON: ${text}` };
}
