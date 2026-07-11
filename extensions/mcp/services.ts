import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolve } from "node:path";
import type { CodexMcpServerConfig, McpConnectionStatus } from "./types.ts";

interface McpConnection {
	client: Client;
	transport: Transport;
	server: CodexMcpServerConfig;
	lastUsedAt: number;
	inFlight: number;
}

export interface McpToolListItem {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		openWorldHint?: boolean;
	};
}

export type McpToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

function interpolateEnv(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, bare: string | undefined) => {
		return process.env[braced ?? bare ?? ""] ?? "";
	});
}

function resolveEnv(env?: Record<string, string>): Record<string, string> {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") base[key] = value;
	}
	if (!env) return base;
	for (const [key, value] of Object.entries(env)) base[key] = interpolateEnv(value);
	return base;
}

function resolveHeaders(server: CodexMcpServerConfig): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(server.http_headers ?? {})) headers[key] = interpolateEnv(value);
	for (const [key, envName] of Object.entries(server.env_http_headers ?? {})) {
		const value = process.env[envName];
		if (value) headers[key] = value;
	}
	if (server.bearer_token_env_var) {
		const token = process.env[server.bearer_token_env_var];
		if (token) headers.Authorization = `Bearer ${token}`;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function resolveServerCwd(cwd: string, serverCwd?: string): string | undefined {
	if (!serverCwd) return undefined;
	return resolve(cwd, interpolateEnv(serverCwd));
}

export class McpClientManager {
	private connections = new Map<string, McpConnection>();
	private connectionPromises = new Map<string, Promise<McpConnection>>();
	private readonly idleTimeoutMs: number;

	constructor(
		private readonly cwd: string,
		private readonly getServer: (serverName: string) => CodexMcpServerConfig | undefined,
		options: { idleTimeoutMs?: number } = {},
	) {
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	}

	getStatus(serverName: string): McpConnectionStatus {
		if (this.connections.has(serverName)) return "connected";
		if (this.connectionPromises.has(serverName)) return "connecting";
		return "disconnected";
	}

	async connect(serverName: string): Promise<McpConnection> {
		const existing = this.connections.get(serverName);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing;
		}

		const pending = this.connectionPromises.get(serverName);
		if (pending) return pending;

		const promise = this.createConnection(serverName);
		this.connectionPromises.set(serverName, promise);
		try {
			const connection = await promise;
			this.connections.set(serverName, connection);
			return connection;
		} finally {
			this.connectionPromises.delete(serverName);
		}
	}

	private async createConnection(serverName: string): Promise<McpConnection> {
		const server = this.getServer(serverName);
		if (!server) throw new Error(`MCP server not configured: ${serverName}`);
		if (server.enabled === false) throw new Error(`MCP server disabled: ${serverName}`);

		const client = new Client({ name: `pi-mcp-${serverName}`, version: "1.0.0" });
		const transport = this.createTransport(server);
		try {
			await client.connect(transport, { timeout: (server.startup_timeout_sec ?? DEFAULT_STARTUP_TIMEOUT_MS / 1000) * 1000 });
			return { client, transport, server, lastUsedAt: Date.now(), inFlight: 0 };
		} catch (error) {
			await client.close().catch(() => undefined);
			await transport.close?.().catch(() => undefined);
			throw error;
		}
	}

	private createTransport(server: CodexMcpServerConfig): Transport {
		if (server.command) {
			return new StdioClientTransport({
				command: server.command,
				args: server.args ?? [],
				env: resolveEnv(server.env),
				cwd: resolveServerCwd(this.cwd, server.cwd),
				stderr: "ignore",
			});
		}

		if (server.url) {
			const headers = resolveHeaders(server);
			return new StreamableHTTPClientTransport(new URL(interpolateEnv(server.url)), headers ? { requestInit: { headers } } : undefined);
		}

		throw new Error("MCP server must define either command or url");
	}

	async listTools(serverName: string): Promise<McpToolListItem[]> {
		const connection = await this.connect(serverName);
		connection.lastUsedAt = Date.now();
		connection.inFlight++;
		try {
			const tools: McpToolListItem[] = [];
			let cursor: string | undefined;
			do {
				const result = await connection.client.listTools(cursor ? { cursor } : undefined, {
					timeout: (connection.server.startup_timeout_sec ?? DEFAULT_STARTUP_TIMEOUT_MS / 1000) * 1000,
				});
				tools.push(...result.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					annotations: tool.annotations,
				})));
				cursor = result.nextCursor;
			} while (cursor);
			return tools;
		} finally {
			connection.inFlight--;
			connection.lastUsedAt = Date.now();
		}
	}

	async callTool(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
		const connection = await this.connect(serverName);
		connection.lastUsedAt = Date.now();
		connection.inFlight++;
		try {
			return await connection.client.callTool(
				{ name: toolName, arguments: args },
				undefined,
				{ signal, timeout: (connection.server.tool_timeout_sec ?? DEFAULT_TOOL_TIMEOUT_MS / 1000) * 1000 },
			);
		} finally {
			connection.inFlight--;
			connection.lastUsedAt = Date.now();
		}
	}

	async close(serverName: string): Promise<void> {
		const connection = this.connections.get(serverName);
		if (!connection) return;
		this.connections.delete(serverName);
		await connection.client.close().catch(() => undefined);
		await connection.transport.close?.().catch(() => undefined);
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.connections.keys()].map((serverName) => this.close(serverName)));
	}

	async closeIdle(): Promise<void> {
		const now = Date.now();
		await Promise.all(
			[...this.connections.entries()]
				.filter(([, connection]) => connection.inFlight === 0 && now - connection.lastUsedAt > this.idleTimeoutMs)
				.map(([serverName]) => this.close(serverName)),
		);
	}
}
