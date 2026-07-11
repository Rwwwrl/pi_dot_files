export interface CodexMcpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;

	url?: string;
	bearer_token_env_var?: string;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>;

	enabled?: boolean;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
	enabled_tools?: string[];
	disabled_tools?: string[];
}

export interface CodexMcpConfig {
	mcpServers: Record<string, CodexMcpServerConfig>;
}

export interface McpToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	openWorldHint?: boolean;
}

export interface CachedMcpTool {
	serverName: string;
	originalName: string;
	piToolName: string;
	description: string;
	inputSchema: unknown;
	annotations?: McpToolAnnotations;
}

export interface CachedMcpServer {
	serverName: string;
	configHash: string;
	refreshedAt: number;
	tools: CachedMcpTool[];
	error?: string;
}

export interface ProjectMcpCache {
	configPath: string;
	configHash: string;
	servers: Record<string, CachedMcpServer>;
}

export interface McpMetadataCache {
	version: 1;
	projects: Record<string, ProjectMcpCache>;
}

export interface LoadedMcpProject {
	cwd: string;
	configPath: string;
	configHash: string;
	config: CodexMcpConfig;
	cache: ProjectMcpCache;
}

export interface RegisteredMcpTool {
	cached: CachedMcpTool;
	server: CodexMcpServerConfig;
}

export interface ToolRegistrationReport {
	registered: CachedMcpTool[];
	skipped: Array<{ tool: CachedMcpTool; reason: string }>;
}

export type McpConnectionStatus = "connected" | "disconnected" | "connecting";
