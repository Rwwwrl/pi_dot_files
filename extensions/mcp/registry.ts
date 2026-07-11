import type { McpToolAnnotations } from "./types.ts";

export interface RegisteredMcpToolPolicy {
	name: string;
	serverName: string;
	originalName: string;
	annotations?: McpToolAnnotations;
}

let registeredMcpTools = new Map<string, RegisteredMcpToolPolicy>();

export function setRegisteredMcpTools(tools: RegisteredMcpToolPolicy[]): void {
	registeredMcpTools = new Map(tools.map((tool) => [tool.name, tool]));
}

export function getRegisteredMcpToolNames(): Set<string> {
	return new Set(registeredMcpTools.keys());
}

export function getRegisteredMcpToolPolicy(name: string): RegisteredMcpToolPolicy | undefined {
	return registeredMcpTools.get(name);
}

export function isRegisteredMcpTool(name: string): boolean {
	return registeredMcpTools.has(name);
}
