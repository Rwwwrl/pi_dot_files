import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { CachedMcpServer, CodexMcpConfig, CodexMcpServerConfig, LoadedMcpProject, McpMetadataCache, ProjectMcpCache } from "./types.ts";

const CACHE_VERSION = 1 as const;
const MCP_CONFIG_PATH = ".mcp.json";
const CACHE_FILE_NAME = "mcp-cache.json";

export function getMcpConfigPath(cwd: string): string {
	return resolve(cwd, MCP_CONFIG_PATH);
}

export function getMcpCachePath(): string {
	return resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi", "agent"), CACHE_FILE_NAME);
}

export function stableHash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const output: Record<string, string> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (typeof child === "string") output[key] = child;
		else if (typeof child === "number" && Number.isFinite(child)) output[key] = String(child);
	}
	return Object.keys(output).length > 0 ? output : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeServerConfig(raw: unknown): CodexMcpServerConfig | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Record<string, unknown>;
	const server: CodexMcpServerConfig = {};
	if (typeof input.command === "string") server.command = input.command;
	const args = asStringArray(input.args);
	if (args) server.args = args;
	const env = asStringRecord(input.env);
	if (env) server.env = env;
	if (typeof input.cwd === "string") server.cwd = input.cwd;
	if (typeof input.url === "string") server.url = input.url;
	if (typeof input.bearer_token_env_var === "string") server.bearer_token_env_var = input.bearer_token_env_var;
	const httpHeaders = asStringRecord(input.http_headers ?? input.headers);
	if (httpHeaders) server.http_headers = httpHeaders;
	const envHttpHeaders = asStringRecord(input.env_http_headers);
	if (envHttpHeaders) server.env_http_headers = envHttpHeaders;
	if (typeof input.enabled === "boolean") server.enabled = input.enabled;
	const startupTimeoutSec = asNumber(input.startup_timeout_sec);
	if (startupTimeoutSec !== undefined) server.startup_timeout_sec = startupTimeoutSec;
	const toolTimeoutSec = asNumber(input.tool_timeout_sec);
	if (toolTimeoutSec !== undefined) server.tool_timeout_sec = toolTimeoutSec;
	const enabledTools = asStringArray(input.enabled_tools);
	if (enabledTools) server.enabled_tools = enabledTools;
	const disabledTools = asStringArray(input.disabled_tools);
	if (disabledTools) server.disabled_tools = disabledTools;
	return server;
}

export function parseMcpConfigJson(text: string): CodexMcpConfig {
	const raw = JSON.parse(text) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mcpServers: {} };
	const root = raw as Record<string, unknown>;
	const rawServers = root.mcpServers ?? root.servers;
	if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) return { mcpServers: {} };

	const mcpServers: Record<string, CodexMcpServerConfig> = {};
	for (const [serverName, rawServer] of Object.entries(rawServers as Record<string, unknown>)) {
		const server = normalizeServerConfig(rawServer);
		if (server) mcpServers[serverName] = server;
	}
	return { mcpServers };
}

export function setMcpServerEnabled(configPath: string, serverName: string, enabled: boolean): void {
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP config must be a JSON object");
	const root = raw as Record<string, unknown>;
	const serversKey = root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers) ? "mcpServers" : "servers";
	const servers = root[serversKey];
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP config must contain mcpServers or servers");
	const server = (servers as Record<string, unknown>)[serverName];
	if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error(`MCP server is not configured: ${serverName}`);
	(server as Record<string, unknown>).enabled = enabled;
	writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

export function loadMcpConfig(cwd: string): { path: string; config: CodexMcpConfig; hash: string; exists: boolean; error?: string } {
	const path = getMcpConfigPath(cwd);
	if (!existsSync(path)) return { path, config: { mcpServers: {} }, hash: stableHash({}), exists: false };
	try {
		const text = readFileSync(path, "utf8");
		const config = parseMcpConfigJson(text);
		return { path, config, hash: stableHash(config), exists: true };
	} catch (error) {
		return {
			path,
			config: { mcpServers: {} },
			hash: stableHash({ error: String(error) }),
			exists: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function loadMetadataCache(cachePath = getMcpCachePath()): McpMetadataCache {
	if (!existsSync(cachePath)) return { version: CACHE_VERSION, projects: {} };
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<McpMetadataCache>;
		if (parsed.version !== CACHE_VERSION || !parsed.projects || typeof parsed.projects !== "object") {
			return { version: CACHE_VERSION, projects: {} };
		}
		return { version: CACHE_VERSION, projects: parsed.projects as Record<string, ProjectMcpCache> };
	} catch {
		return { version: CACHE_VERSION, projects: {} };
	}
}

export function saveMetadataCache(cache: McpMetadataCache, cachePath = getMcpCachePath()): void {
	mkdirSync(dirname(cachePath), { recursive: true });
	const tmp = `${cachePath}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
	renameSync(tmp, cachePath);
}

export function getProjectCache(cache: McpMetadataCache, cwd: string, configPath: string, configHash: string): ProjectMcpCache {
	const key = resolve(cwd);
	const existing = cache.projects[key];
	if (existing?.configPath === configPath && existing.configHash === configHash) return existing;
	const next: ProjectMcpCache = { configPath, configHash, servers: {} };
	cache.projects[key] = next;
	return next;
}

export function loadMcpProject(cwd: string): LoadedMcpProject & { configExists: boolean; configError?: string } {
	const loaded = loadMcpConfig(cwd);
	const metadataCache = loadMetadataCache();
	const projectCache = getProjectCache(metadataCache, cwd, loaded.path, loaded.hash);
	return {
		cwd,
		configPath: loaded.path,
		configHash: loaded.hash,
		config: loaded.config,
		cache: projectCache,
		configExists: loaded.exists,
		configError: loaded.error,
	};
}

export function saveProjectCache(cwd: string, project: ProjectMcpCache): void {
	const cache = loadMetadataCache();
	cache.projects[resolve(cwd)] = project;
	saveMetadataCache(cache);
}

export function filterCachedServers(config: CodexMcpConfig, cache: ProjectMcpCache): CachedMcpServer[] {
	return Object.entries(config.mcpServers)
		.filter(([, server]) => server.enabled !== false)
		.map(([name]) => cache.servers[name])
		.filter((server): server is CachedMcpServer => !!server);
}

export function serverConfigHash(server: CodexMcpServerConfig): string {
	return stableHash(server);
}
