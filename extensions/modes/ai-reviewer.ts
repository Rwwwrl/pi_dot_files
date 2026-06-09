import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

interface GateReviewOptions {
	gateName: string;
	systemPrompt: string;
	toolName: string;
	input: Record<string, unknown>;
	triageReason: string;
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

export async function reviewToolCallWithGate(
	ctx: ExtensionContext,
	options: GateReviewOptions,
): Promise<{ allow: boolean; reason: string }> {
	if (!ctx.model) {
		return { allow: false, reason: `No model is selected, so ${options.gateName} safety review cannot run.` };
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
				text: `Current working directory: ${ctx.cwd}\nTriage reason: ${options.triageReason}\n\nRecent conversation:\n${getRecentConversationForReview(ctx) || "(none)"}\n\nProposed tool call:\nTool: ${options.toolName}\nInput:\n${stringifyToolInput(options.input)}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: options.systemPrompt, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
	);

	if (response.stopReason === "aborted") {
		return { allow: false, reason: `${options.gateName} safety review was aborted.` };
	}

	const text = response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return parseReviewDecision(text) ?? { allow: false, reason: `${options.gateName} safety review returned invalid JSON: ${text}` };
}

const RESEARCH_REVIEW_SYSTEM_PROMPT = `You are a research-gate security reviewer for a coding agent. Decide whether a proposed tool call is safe research.

Return strict JSON only: {"allow": true|false, "reason": "short explanation"}.

Policy:
- Allow inspection, search, reading ordinary files, tests, builds/checks, typechecks, linters, version checks, and package metadata inspection.
- Allow commands whose main purpose is to learn project state, reproduce a failure, or validate an assumption.
- Deny intentional filesystem modifications, edit/write tools, dependency installs/removals/updates, git state mutations, commits, pushes, destructive operations, privilege escalation, process killing, remote state mutations, and publishing.
- Incidental cache or test/build artifacts are acceptable when the command is a normal project validation command and not explicitly writing/changing targeted files.
- Be conservative: if the call is ambiguous or broader than needed, deny it.`;

const EXECUTION_REVIEW_SYSTEM_PROMPT = `You are an execution-gate security reviewer for a coding agent running in automode. Decide whether a proposed tool call may run without asking the user.

Return strict JSON only: {"allow": true|false, "reason": "short explanation"}.

Policy:
- Allow ordinary source-code write/edit operations that are scoped to the current workspace and match the user's task.
- Allow normal inspection, tests, builds, typechecks, and lint commands.
- Deny irreversible destructive operations, privilege escalation, hidden persistence, publishing, force-pushing, or commands unrelated to the user's task.
- For package installs, git history mutations, deletions, network downloads, and shell scripts, allow only when clearly necessary, explicitly requested or strongly implied by the task, and reasonably safe.
- Be conservative: if the call is ambiguous or broader than needed, deny it.`;

export async function reviewToolCallWithResearchGate(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	triageReason: string,
): Promise<{ allow: boolean; reason: string }> {
	return reviewToolCallWithGate(ctx, {
		gateName: "Research-gate",
		systemPrompt: RESEARCH_REVIEW_SYSTEM_PROMPT,
		toolName,
		input,
		triageReason,
	});
}

export async function reviewToolCallWithExecutionGate(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	triageReason: string,
): Promise<{ allow: boolean; reason: string }> {
	return reviewToolCallWithGate(ctx, {
		gateName: "Execution-gate",
		systemPrompt: EXECUTION_REVIEW_SYSTEM_PROMPT,
		toolName,
		input,
		triageReason,
	});
}
