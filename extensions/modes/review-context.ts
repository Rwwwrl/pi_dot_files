import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

const REVIEW_MESSAGE_LIMIT = 20;
const REVIEW_PER_MESSAGE_LIMIT = 1600;
const REVIEW_TOTAL_LIMIT = 12000;

export function getMessageText(message: AgentMessage): string {
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

export function formatMessagesForReview(
	messages: AgentMessage[],
	options: { messageLimit?: number; perMessageLimit?: number; totalLimit?: number } = {},
): string {
	const messageLimit = options.messageLimit ?? REVIEW_MESSAGE_LIMIT;
	const perMessageLimit = options.perMessageLimit ?? REVIEW_PER_MESSAGE_LIMIT;
	const totalLimit = options.totalLimit ?? REVIEW_TOTAL_LIMIT;
	const formatted = messages
		.slice(-messageLimit)
		.map((message) => {
			const text = truncateForReview(getMessageText(message), perMessageLimit).trim();
			return text ? `${message.role}: ${text}` : undefined;
		})
		.filter((line): line is string => typeof line === "string");
	return truncateForReview(formatted.join("\n\n"), totalLimit);
}
