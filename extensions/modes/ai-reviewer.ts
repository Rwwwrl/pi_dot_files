import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatMessagesForReview, truncateForReview } from "./review-context.ts";

type GateReviewSource = "tool_call" | "user_bash";

interface GateReviewMetadata {
	source?: GateReviewSource;
	mode?: string;
}

interface GateReviewOptions extends GateReviewMetadata {
	gateName: string;
	systemPrompt: string;
	toolName: string;
	input: Record<string, unknown>;
	triageReason: string;
}


function stringifyToolInput(input: Record<string, unknown>): string {
	try {
		return truncateForReview(JSON.stringify(input, null, 2));
	} catch {
		return truncateForReview(String(input));
	}
}

function getBranchConversationForReview(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	const messages = entries
		.filter((entry): entry is SessionEntry & { type: "message"; message: AgentMessage } => {
			return entry.type === "message" && "message" in entry;
		})
		.map((entry) => entry.message);
	return formatMessagesForReview(messages);
}

function getResolvedConversationForReview(ctx: ExtensionContext): string {
	try {
		// Mirror Pi's resolved LLM-visible context instead of raw branch entries.
		// This includes compaction summaries, branch summaries, and custom messages.
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			buildSessionContext?: () => { messages: AgentMessage[] };
		};
		if (!sessionManager.buildSessionContext) return getBranchConversationForReview(ctx);
		return formatMessagesForReview(sessionManager.buildSessionContext().messages);
	} catch {
		return getBranchConversationForReview(ctx);
	}
}

function formatReviewMetadata(options: GateReviewOptions): string {
	const lines = [];
	if (options.source) lines.push(`Review source: ${options.source}`);
	if (options.mode) lines.push(`Active mode: ${options.mode}`);
	return lines.length ? `${lines.join("\n")}\n` : "";
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
		return { allow: false, reason: `No model is selected, so ${options.gateName} cannot run.` };
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
				text: `Current working directory: ${ctx.cwd}\n${formatReviewMetadata(options)}Triage reason: ${options.triageReason}\n\nResolved conversation context:\n${getResolvedConversationForReview(ctx) || "(none)"}\n\nProposed tool call:\nTool: ${options.toolName}\nInput:\n${stringifyToolInput(options.input)}`,
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

function getAutoreviewerSystemPrompt(): string {
	return `You are the mode-aware safety autoreviewer for a coding agent. Decide whether a proposed tool call may run without asking the user.

Return strict JSON only: {"allow": true|false, "reason": "short explanation"}.

You are given:
- Active mode
- Review source
- Triage reason
- Resolved conversation context
- Proposed tool call

Mode policy:
- In normal, inline, research, plan, and brainstorming modes:
  - Allow only safe research, inspection, and validation.
  - Allow reading/searching ordinary files, package metadata inspection, version checks, tests, builds/checks, typechecks, and linters that do not intentionally modify files.
  - Allow bounded interpreter probes such as python -c, python heredocs, node -e, or similar only when the visible code is clearly for inspection, imports, version checks, metadata lookup, or reading project state.
  - Deny filesystem modifications, edit/write tools, dependency installs/removals/updates, git state mutations, commits, pushes, destructive operations, privilege escalation, process killing, remote state mutations, publishing, long-running services, and unclear side effects.
  - Incidental cache or test/build artifacts are acceptable when the command is a normal project validation command and not explicitly writing/changing targeted files.
  - If a call appears to work around a mode-blocked file operation, deny it; mode policy applies to the operation, not just the tool name.
- In auto mode:
  - Allow ordinary workspace-scoped edits/writes and task-relevant state changes when they clearly match the user's request.
  - Allow normal inspection, tests, builds, typechecks, and lint commands.
  - For package installs, git history mutations, deletions, network downloads, and shell scripts, allow only when clearly necessary, explicitly requested or strongly implied by the task, and reasonably safe.
  - Deny irreversible destructive operations, privilege escalation, hidden persistence, publishing, force-pushing, unrelated actions, or overly broad/ambiguous changes.

Be conservative: if the call is ambiguous or broader than needed, deny it.`;
}

export async function reviewToolCallWithAutoReviewer(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	triageReason: string,
	metadata: GateReviewMetadata = {},
): Promise<{ allow: boolean; reason: string }> {
	return reviewToolCallWithGate(ctx, {
		gateName: "Autoreviewer",
		systemPrompt: getAutoreviewerSystemPrompt(),
		toolName,
		input,
		triageReason,
		...metadata,
	});
}

// Backward-compatible aliases for already-loaded extension code and external imports.
// Both use the single mode-aware autoreviewer prompt above.
export async function reviewToolCallWithResearchGate(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	triageReason: string,
	metadata: GateReviewMetadata = {},
): Promise<{ allow: boolean; reason: string }> {
	return reviewToolCallWithAutoReviewer(ctx, toolName, input, triageReason, metadata);
}

export async function reviewToolCallWithExecutionGate(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	triageReason: string,
	metadata: GateReviewMetadata = {},
): Promise<{ allow: boolean; reason: string }> {
	return reviewToolCallWithAutoReviewer(ctx, toolName, input, triageReason, metadata);
}
