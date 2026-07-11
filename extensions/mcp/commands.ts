import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CachedMcpServer, LoadedMcpProject } from "./types.ts";
import type { McpClientManager } from "./services.ts";
import { saveProjectCache, serverConfigHash, setMcpServerEnabled } from "./repositories.ts";
import { buildCachedTool, getCachedToolsForProject, summarizeMcpToolsByServer } from "./tools.ts";

function enabledServerNames(project: LoadedMcpProject): string[] {
	return Object.entries(project.config.mcpServers)
		.filter(([, server]) => server.enabled !== false)
		.map(([serverName]) => serverName);
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.log(message);
}

function buildStatus(project: LoadedMcpProject, manager: McpClientManager | undefined): string {
	const lines = [`MCP config: ${project.configPath}`];
	const entries = Object.entries(project.config.mcpServers);
	if (entries.length === 0) {
		lines.push("No MCP servers configured.");
		return lines.join("\n");
	}

	for (const [serverName, server] of entries) {
		const cached = project.cache.servers[serverName];
		const enabled = server.enabled !== false;
		const status = manager?.getStatus(serverName) ?? "disconnected";
		const toolCount = cached?.tools.length ?? 0;
		const stale = cached && cached.configHash !== serverConfigHash(server) ? " stale" : "";
		const error = cached?.error ? ` error=${cached.error}` : "";
		lines.push(`- ${serverName}: ${enabled ? "enabled" : "disabled"}, ${toolCount} cached tool(s), ${status}${stale}${error}`);
	}
	return lines.join("\n");
}

function buildTools(project: LoadedMcpProject): string {
	const tools = getCachedToolsForProject(project);
	if (tools.length === 0) return "No cached direct MCP tools registered. Run /mcp refresh.";
	const lines = ["Cached direct MCP tools:"];
	for (const [serverName, serverTools] of summarizeMcpToolsByServer(tools)) {
		lines.push(`- ${serverName}:`);
		for (const tool of serverTools) {
			lines.push(`  - ${tool.piToolName} (${tool.originalName})${tool.description ? ` — ${tool.description}` : ""}`);
		}
	}
	return lines.join("\n");
}

function buildServerLabel(project: LoadedMcpProject, serverName: string): string {
	const server = project.config.mcpServers[serverName];
	const enabled = server?.enabled !== false;
	const toolCount = project.cache.servers[serverName]?.tools.length ?? 0;
	return `${enabled ? "✓" : "○"} ${serverName} (${enabled ? "enabled" : "disabled"}, ${toolCount} cached tool(s))`;
}

async function showMcpManageUi(project: LoadedMcpProject, ctx: ExtensionCommandContext): Promise<void> {
	const entries = Object.keys(project.config.mcpServers);
	if (entries.length === 0) {
		notify(ctx, "No MCP servers configured.", "warning");
		return;
	}
	if (!ctx.hasUI) {
		notify(ctx, "MCP UI is only available in interactive mode. Use /mcp status to inspect configured servers.", "error");
		return;
	}

	const labels = entries.map((serverName) => buildServerLabel(project, serverName));
	const selected = await ctx.ui.select("Enable/disable MCP server", labels);
	if (!selected) return;
	const selectedIndex = labels.indexOf(selected);
	const serverName = entries[selectedIndex];
	if (!serverName) return;

	const enabled = project.config.mcpServers[serverName]?.enabled !== false;
	const action = await ctx.ui.select(`${serverName} is currently ${enabled ? "enabled" : "disabled"}`, [
		enabled ? "Disable" : "Enable",
		"Cancel",
	]);
	if (!action || action === "Cancel") return;

	const nextEnabled = action === "Enable";
	try {
		setMcpServerEnabled(project.configPath, serverName, nextEnabled);
		notify(ctx, `${serverName} ${nextEnabled ? "enabled" : "disabled"}. Reloading session...`);
		await ctx.reload();
	} catch (error) {
		notify(ctx, `Failed to update MCP config: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function refreshServers(project: LoadedMcpProject, manager: McpClientManager, targetServer?: string): Promise<{ refreshed: CachedMcpServer[]; errors: Array<{ server: string; message: string }> }> {
	const names = targetServer ? [targetServer] : enabledServerNames(project);
	const refreshed: CachedMcpServer[] = [];
	const errors: Array<{ server: string; message: string }> = [];

	for (const serverName of names) {
		const server = project.config.mcpServers[serverName];
		if (!server) {
			errors.push({ server: serverName, message: "server is not configured" });
			continue;
		}
		if (server.enabled === false) {
			errors.push({ server: serverName, message: "server is disabled" });
			continue;
		}

		try {
			const listedTools = await manager.listTools(serverName);
			const tools = listedTools.map((tool) => buildCachedTool(serverName, server, tool)).filter((tool): tool is NonNullable<typeof tool> => !!tool);
			const cached: CachedMcpServer = {
				serverName,
				configHash: serverConfigHash(server),
				refreshedAt: Date.now(),
				tools,
			};
			project.cache.servers[serverName] = cached;
			refreshed.push(cached);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			project.cache.servers[serverName] = {
				serverName,
				configHash: serverConfigHash(server),
				refreshedAt: Date.now(),
				tools: [],
				error: message,
			};
			errors.push({ server: serverName, message });
		}
	}

	saveProjectCache(project.cwd, project.cache);
	return { refreshed, errors };
}

export function registerMcpCommand(
	pi: ExtensionAPI,
	getProject: () => LoadedMcpProject,
	getManager: () => McpClientManager | undefined,
): void {
	pi.registerCommand("mcp", {
		description: "Manage direct MCP tools: status, tools, refresh [server], manage",
		handler: async (args, ctx) => {
			const project = getProject();
			const [subcommand = "status", maybeServer] = args.trim().split(/\s+/).filter(Boolean);
			const manager = getManager();

			if (subcommand === "status" || subcommand === "") {
				notify(ctx, buildStatus(project, manager));
				return;
			}

			if (subcommand === "tools") {
				notify(ctx, buildTools(project));
				return;
			}

			if (subcommand === "manage" || subcommand === "ui") {
				await showMcpManageUi(project, ctx);
				return;
			}

			if (subcommand === "refresh") {
				if (!manager) {
					notify(ctx, "MCP manager is not initialized yet.", "error");
					return;
				}
				const result = await refreshServers(project, manager, maybeServer);
				const refreshedTools = result.refreshed.reduce((sum, server) => sum + server.tools.length, 0);
				const errorLines = result.errors.map((error) => `${error.server}: ${error.message}`);
				const message = [`Refreshed ${result.refreshed.length} MCP server(s), cached ${refreshedTools} direct tool(s).`, ...errorLines.map((line) => `Error: ${line}`)].join("\n");
				notify(ctx, message, result.errors.length > 0 ? "warning" : "info");
				if (result.refreshed.length > 0) {
					await ctx.reload();
				}
				return;
			}

			notify(ctx, "Usage: /mcp [status|tools|refresh [server]|manage]", "error");
		},
	});
}
