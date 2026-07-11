import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { CachedMcpTool, CodexMcpConfig, CodexMcpServerConfig, LoadedMcpProject, ToolRegistrationReport } from "./types.ts";
import type { McpClientManager, McpToolCallResult, McpToolListItem } from "./services.ts";
import { serverConfigHash } from "./repositories.ts";
import { setRegisteredMcpTools } from "./registry.ts";

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const MAX_MCP_TEXT_BLOCK_CHARS = 12_000;
const MAX_MCP_TOTAL_TEXT_CHARS = 24_000;

export function sanitizeToolNamePart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_").toLowerCase();
	return sanitized || "mcp";
}

export function formatMcpToolName(serverName: string, toolName: string): string {
	return `${sanitizeToolNamePart(serverName)}_${sanitizeToolNamePart(toolName)}`;
}

export function shouldIncludeMcpTool(server: CodexMcpServerConfig, toolName: string): boolean {
	if (server.enabled_tools && !server.enabled_tools.includes(toolName)) return false;
	if (server.disabled_tools?.includes(toolName)) return false;
	return true;
}

function normalizeInputSchema(schema: unknown): ToolDefinition["parameters"] {
	if (schema && typeof schema === "object" && !Array.isArray(schema)) return schema as ToolDefinition["parameters"];
	return { type: "object", properties: {}, additionalProperties: true } as ToolDefinition["parameters"];
}

function truncateDescription(description: string, max = 140): string {
	const oneLine = description.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function buildCachedTool(serverName: string, server: CodexMcpServerConfig, tool: McpToolListItem): CachedMcpTool | undefined {
	if (!shouldIncludeMcpTool(server, tool.name)) return undefined;
	return {
		serverName,
		originalName: tool.name,
		piToolName: formatMcpToolName(serverName, tool.name),
		description: tool.description ?? "",
		inputSchema: normalizeInputSchema(tool.inputSchema),
		annotations: tool.annotations,
	};
}

export function getCachedToolsForProject(project: LoadedMcpProject): CachedMcpTool[] {
	const tools: CachedMcpTool[] = [];
	for (const [serverName, server] of Object.entries(project.config.mcpServers)) {
		if (server.enabled === false) continue;
		const cachedServer = project.cache.servers[serverName];
		if (!cachedServer || cachedServer.configHash !== serverConfigHash(server)) continue;
		for (const tool of cachedServer.tools) {
			if (shouldIncludeMcpTool(server, tool.originalName)) tools.push(tool);
		}
	}
	return tools;
}

function isCallToolResultWithContent(result: McpToolCallResult): result is Extract<McpToolCallResult, { content: unknown[] }> {
	return typeof result === "object" && result !== null && "content" in result && Array.isArray((result as { content?: unknown }).content);
}

function stringifyStructuredContent(result: McpToolCallResult): string | undefined {
	if (typeof result !== "object" || result === null || !("structuredContent" in result)) return undefined;
	const structured = (result as { structuredContent?: unknown }).structuredContent;
	if (structured === undefined) return undefined;
	return JSON.stringify(structured, null, 2);
}

function truncateMcpText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const omitted = text.length - maxChars;
	return {
		text: `${text.slice(0, maxChars)}\n\n[... MCP result truncated: omitted ${omitted} characters ...]`,
		truncated: true,
	};
}

function truncateMcpContent(content: Array<TextContent | ImageContent>): { content: Array<TextContent | ImageContent>; truncated: boolean } {
	const output: Array<TextContent | ImageContent> = [];
	let remainingTextChars = MAX_MCP_TOTAL_TEXT_CHARS;
	let truncated = false;

	for (const block of content) {
		if (block.type !== "text") {
			output.push(block);
			continue;
		}

		if (remainingTextChars <= 0) {
			truncated = true;
			continue;
		}

		const limit = Math.min(MAX_MCP_TEXT_BLOCK_CHARS, remainingTextChars);
		const truncatedBlock = truncateMcpText(block.text, limit);
		output.push({ type: "text", text: truncatedBlock.text });
		remainingTextChars -= Math.min(block.text.length, limit);
		truncated ||= truncatedBlock.truncated;
	}

	if (truncated && output.every((block) => block.type !== "text" || !block.text.includes("MCP result truncated"))) {
		output.push({ type: "text", text: "[... MCP result truncated: omitted additional text blocks ...]" });
	}

	return { content: output, truncated };
}

export function transformMcpToolResult(result: McpToolCallResult, serverName: string, toolName: string): AgentToolResult<Record<string, unknown>> {
	const content: Array<TextContent | ImageContent> = [];

	if (isCallToolResultWithContent(result)) {
		for (const block of result.content) {
			if (!block || typeof block !== "object") continue;
			const typed = block as Record<string, unknown>;
			if (typed.type === "text" && typeof typed.text === "string") {
				content.push({ type: "text", text: typed.text });
			} else if (typed.type === "image" && typeof typed.data === "string" && typeof typed.mimeType === "string") {
				content.push({ type: "image", data: typed.data, mimeType: typed.mimeType });
			} else if (typed.type === "resource" && typed.resource && typeof typed.resource === "object") {
				const resource = typed.resource as Record<string, unknown>;
				if (typeof resource.text === "string") {
					content.push({ type: "text", text: resource.text });
				} else {
					content.push({ type: "text", text: `[MCP resource: ${String(resource.uri ?? "unknown")}]` });
				}
			} else if (typed.type === "resource_link") {
				content.push({ type: "text", text: `[MCP resource link: ${String(typed.name ?? typed.uri ?? "unknown")}]` });
			} else {
				content.push({ type: "text", text: `[Unsupported MCP content: ${String(typed.type ?? "unknown")}]` });
			}
		}
	}

	const structured = stringifyStructuredContent(result);
	if (structured) content.push({ type: "text", text: `Structured content:\n${structured}` });
	if (content.length === 0) content.push({ type: "text", text: "(empty MCP result)" });

	const isError = typeof result === "object" && result !== null && "isError" in result && (result as { isError?: boolean }).isError === true;
	const outputContent = isError ? [{ type: "text" as const, text: `MCP tool returned an error:\n${content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n")}` }] : content;
	const truncated = truncateMcpContent(outputContent);
	return {
		content: truncated.content,
		details: { server: serverName, tool: toolName, isError, truncated: truncated.truncated },
	};
}

export function registerCachedMcpTools(
	pi: ExtensionAPI,
	project: LoadedMcpProject,
	getManager: () => McpClientManager | undefined,
): ToolRegistrationReport {
	const report: ToolRegistrationReport = { registered: [], skipped: [] };
	const seen = new Set<string>();

	for (const cached of getCachedToolsForProject(project)) {
		const server = project.config.mcpServers[cached.serverName];
		if (!server) continue;
		if (BUILTIN_TOOL_NAMES.has(cached.piToolName) || seen.has(cached.piToolName)) {
			report.skipped.push({ tool: cached, reason: `tool name collision: ${cached.piToolName}` });
			continue;
		}

		seen.add(cached.piToolName);
		pi.registerTool({
			name: cached.piToolName,
			label: `MCP: ${cached.serverName}.${cached.originalName}`,
			description: cached.description || `MCP tool ${cached.originalName} from ${cached.serverName}`,
			promptSnippet: truncateDescription(cached.description || `MCP tool ${cached.originalName} from ${cached.serverName}`),
			parameters: normalizeInputSchema(cached.inputSchema),
			async execute(_toolCallId, params, signal) {
				const manager = getManager();
				if (!manager) {
					return {
						content: [{ type: "text", text: "MCP manager is not initialized yet." }],
						details: { server: cached.serverName, tool: cached.originalName, error: "not_initialized" },
					};
				}
				const result = await manager.callTool(cached.serverName, cached.originalName, params as Record<string, unknown>, signal);
				return transformMcpToolResult(result, cached.serverName, cached.originalName);
			},
		});
		report.registered.push(cached);
	}

	setRegisteredMcpTools(report.registered.map((tool) => ({
		name: tool.piToolName,
		serverName: tool.serverName,
		originalName: tool.originalName,
		annotations: tool.annotations,
	})));

	return report;
}

export function summarizeMcpToolsByServer(tools: readonly CachedMcpTool[]): Map<string, CachedMcpTool[]> {
	const byServer = new Map<string, CachedMcpTool[]>();
	for (const tool of tools) {
		const list = byServer.get(tool.serverName) ?? [];
		list.push(tool);
		byServer.set(tool.serverName, list);
	}
	return byServer;
}
