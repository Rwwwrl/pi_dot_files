import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMcpConfigJson, setMcpServerEnabled, stableHash } from "../mcp/repositories.ts";
import { buildCachedTool, formatMcpToolName, sanitizeToolNamePart, shouldIncludeMcpTool, transformMcpToolResult } from "../mcp/tools.ts";
import { setRegisteredMcpTools } from "../mcp/registry.ts";
import { classifyExecutionToolCall, classifyResearchToolCall } from "../modes/policies.ts";

afterEach(() => {
	setRegisteredMcpTools([]);
});

describe("MCP JSON config parsing", () => {
	it("parses project-local mcpServers config", () => {
		const config = parseMcpConfigJson(JSON.stringify({
			mcpServers: {
				context7: {
					command: "npx",
					args: ["-y", "@upstash/context7-mcp"],
					enabled: true,
					startup_timeout_sec: 10,
					tool_timeout_sec: 60,
					enabled_tools: ["resolve-library-id", "get-library-docs"],
					disabled_tools: ["write-docs"],
				},
				github: {
					env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", RETRIES: 3, UNUSED: null },
				},
			},
		}));

		assert.deepEqual(config.mcpServers.context7, {
			command: "npx",
			args: ["-y", "@upstash/context7-mcp"],
			enabled: true,
			startup_timeout_sec: 10,
			tool_timeout_sec: 60,
			enabled_tools: ["resolve-library-id", "get-library-docs"],
			disabled_tools: ["write-docs"],
		});
		assert.deepEqual(config.mcpServers.github.env, { GITHUB_TOKEN: "${GITHUB_TOKEN}", RETRIES: "3" });
	});

	it("parses VS Code-style servers config", () => {
		const config = parseMcpConfigJson(JSON.stringify({
			servers: {
				context7: {
					type: "http",
					url: "https://mcp.context7.com/mcp",
					headers: { Authorization: "Bearer ${CONTEXT7_TOKEN}" },
				},
			},
		}));

		assert.deepEqual(config.mcpServers.context7, {
			url: "https://mcp.context7.com/mcp",
			http_headers: { Authorization: "Bearer ${CONTEXT7_TOKEN}" },
		});
	});

	it("updates configured server enabled flags", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
		try {
			const path = join(dir, ".mcp.json");
			writeFileSync(path, JSON.stringify({ mcpServers: { grafana: { url: "https://grafana.example/mcp" } } }), "utf8");
			setMcpServerEnabled(path, "grafana", false);
			assert.equal(JSON.parse(readFileSync(path, "utf8")).mcpServers.grafana.enabled, false);
			setMcpServerEnabled(path, "grafana", true);
			assert.equal(JSON.parse(readFileSync(path, "utf8")).mcpServers.grafana.enabled, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds stable config hashes independent of object key order", () => {
		assert.equal(stableHash({ b: 1, a: 2 }), stableHash({ a: 2, b: 1 }));
	});
});

describe("direct MCP tool metadata", () => {
	it("sanitizes and prefixes MCP tool names", () => {
		assert.equal(sanitizeToolNamePart("Chrome DevTools MCP"), "chrome_devtools_mcp");
		assert.equal(formatMcpToolName("chrome-devtools", "take_screenshot"), "chrome_devtools_take_screenshot");
	});

	it("applies enabled_tools and disabled_tools filters", () => {
		const server = { enabled_tools: ["read"], disabled_tools: ["write"] };
		assert.equal(shouldIncludeMcpTool(server, "read"), true);
		assert.equal(shouldIncludeMcpTool(server, "write"), false);
		assert.equal(shouldIncludeMcpTool(server, "other"), false);
	});

	it("builds cached direct tools with annotations", () => {
		const cached = buildCachedTool("docs", {}, {
			name: "lookup",
			description: "Look up docs",
			inputSchema: { type: "object", properties: { q: { type: "string" } } },
			annotations: { readOnlyHint: true },
		});
		assert.deepEqual(cached, {
			serverName: "docs",
			originalName: "lookup",
			piToolName: "docs_lookup",
			description: "Look up docs",
			inputSchema: { type: "object", properties: { q: { type: "string" } } },
			annotations: { readOnlyHint: true },
		});
	});

	it("truncates large MCP text results", () => {
		const transformed = transformMcpToolResult({ content: [{ type: "text", text: "x".repeat(20_000) }] }, "grafana", "query");
		const text = transformed.content[0]?.type === "text" ? transformed.content[0].text : "";
		assert.equal(transformed.details.truncated, true);
		assert.equal(text.includes("MCP result truncated"), true);
		assert.ok(text.length < 13_000);
	});
});

describe("MCP mode policy", () => {
	it("allows read-only MCP tools in research mode", () => {
		setRegisteredMcpTools([{ name: "docs_lookup", serverName: "docs", originalName: "lookup", annotations: { readOnlyHint: true } }]);
		assert.equal(classifyResearchToolCall("docs_lookup", {}).decision, "allow");
	});

	it("denies destructive MCP tools in research mode but reviews them in auto mode", () => {
		setRegisteredMcpTools([{ name: "github_delete_issue", serverName: "github", originalName: "delete_issue", annotations: { destructiveHint: true } }]);
		assert.equal(classifyResearchToolCall("github_delete_issue", {}).decision, "deny");
		assert.equal(classifyExecutionToolCall("github_delete_issue", {}).decision, "review");
	});

	it("reviews MCP tools without read-only metadata", () => {
		setRegisteredMcpTools([{ name: "api_call", serverName: "api", originalName: "call" }]);
		assert.equal(classifyResearchToolCall("api_call", {}).decision, "review");
	});
});
