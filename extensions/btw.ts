import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const MAX_CONTEXT_MESSAGES = 30;
const MAX_CONTEXT_CHARS = 18_000;
const MAX_MESSAGE_CHARS = 2_000;

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (typeof block !== "object" || block === null) return stringifyUnknown(block);
			const typed = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown };

			if (typed.type === "text" && typeof typed.text === "string") return typed.text;
			if (typed.type === "image") return "[image]";
			if (typed.type === "tool_use") {
				const name = typeof typed.name === "string" ? typed.name : "tool";
				return `[tool_use ${name}: ${truncate(stringifyUnknown(typed.input), 500)}]`;
			}
			if (typed.type === "tool_result") return `[tool_result: ${truncate(contentToText(typed.content) || stringifyUnknown(typed.content), 1_000)}]`;
			if (typeof typed.content === "string") return typed.content;
			return stringifyUnknown(block);
		})
		.filter((text) => text.trim().length > 0)
		.join("\n");
}

function getMessageText(message: AgentMessage): string {
	return contentToText((message as { content?: unknown }).content);
}

function getRecentConversation(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getBranch();
	const messages = entries
		.filter((entry): entry is SessionEntry & { type: "message"; message: AgentMessage } => {
			return entry.type === "message" && "message" in entry;
		})
		.slice(-MAX_CONTEXT_MESSAGES)
		.map((entry) => {
			const text = truncate(getMessageText(entry.message).trim(), MAX_MESSAGE_CHARS);
			return text ? `${entry.message.role}: ${text}` : "";
		})
		.filter(Boolean);

	return truncate(messages.join("\n\n"), MAX_CONTEXT_CHARS);
}

function extractText(response: { content?: unknown }): string {
	const content = response.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is TextContent => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function buildSideQuestionPrompt(ctx: ExtensionCommandContext, question: string): Message {
	const recentConversation = getRecentConversation(ctx);
	const contextBlock = recentConversation || "(no prior conversation context)";

	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `Current working directory: ${ctx.cwd}\n\nRecent main conversation context:\n${contextBlock}\n\nSide question:\n${question}`,
			},
		],
		timestamp: Date.now(),
	};
}

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw", {
		description: "Ask a quick side question without interrupting the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <side question>", "warning");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("/btw needs a selected model.", "warning");
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.setStatus("btw", ctx.ui.theme.fg("warning", "btw: answering…"));
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok || !auth.apiKey) {
					ctx.ui.notify(auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error, "warning");
					return;
				}

				const response = await complete(
					ctx.model,
					{
						systemPrompt: `${ctx.getSystemPrompt()}\n\n[BTW SIDE QUESTION]\nThe user is asking a quick side question via /btw. Answer using the provided conversation context and your general knowledge only. Do not use tools, do not modify files, and do not steer or interrupt the main task. If you do not know, say so. Keep the answer focused and concise.`,
						messages: [buildSideQuestionPrompt(ctx, question)],
					},
					{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
				);

				if (response.stopReason === "aborted") {
					ctx.ui.notify("/btw side question aborted.", "warning");
					return;
				}

				const answer = extractText(response) || "(No response received.)";
				pi.sendMessage(
					{
						customType: "btw-answer",
						content: `**/btw** ${question}\n\n${answer}`,
						display: true,
						details: { question },
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/btw failed: ${message}`, "error");
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("btw", undefined);
			}
		},
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const customMessage = message as AgentMessage & { customType?: string };
				return customMessage.customType !== "btw-answer";
			}),
		};
	});
}
