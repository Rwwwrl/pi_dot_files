import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpCommand } from "./commands.ts";
import { loadMcpProject } from "./repositories.ts";
import { McpClientManager } from "./services.ts";
import { registerCachedMcpTools } from "./tools.ts";
import { setRegisteredMcpTools } from "./registry.ts";
import type { LoadedMcpProject } from "./types.ts";

export default function codexMcpExtension(pi: ExtensionAPI): void {
	let project: LoadedMcpProject & { configExists?: boolean; configError?: string } = loadMcpProject(process.cwd());
	let manager: McpClientManager | undefined;
	let idleTimer: NodeJS.Timeout | undefined;

	registerCachedMcpTools(pi, project, () => manager);

	async function shutdown(): Promise<void> {
		if (idleTimer) {
			clearInterval(idleTimer);
			idleTimer = undefined;
		}
		const current = manager;
		manager = undefined;
		await current?.closeAll();
	}

	registerMcpCommand(pi, () => project, () => manager);

	pi.on("session_start", async (_event, ctx) => {
		await shutdown();
		project = loadMcpProject(ctx.cwd);
		manager = new McpClientManager(ctx.cwd, (serverName) => project.config.mcpServers[serverName]);
		idleTimer = setInterval(() => {
			void manager?.closeIdle().catch(() => undefined);
		}, 60_000);
		idleTimer.unref?.();
		if (project.configError && ctx.hasUI) ctx.ui.notify(`Failed to load MCP config: ${project.configError}`, "error");
	});

	pi.on("session_shutdown", async () => {
		await shutdown();
		setRegisteredMcpTools([]);
	});
}
