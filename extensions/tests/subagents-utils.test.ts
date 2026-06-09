import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	applyJsonEventToResult,
	buildSubagentPrompt,
	CHILD_TOOL_NAMES,
	childModeFlagForParentMode,
	childModeNameForParentMode,
	clampConcurrency,
	createEmptyUsage,
	getFinalOutput,
	getToolCalls,
	isSubagentParentMode,
	shouldMarkSubagentsError,
	truncateTaskOutput,
	type SubagentResult,
} from "../subagents/utils.ts";

function emptyResult(): SubagentResult {
	return {
		index: 0,
		task: "Inspect the project",
		parentMode: "research",
		childMode: "research",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: createEmptyUsage(),
	};
}

describe("subagents utils", () => {
	it("exposes only read-only child tools and excludes recursive/modify tools", () => {
		assert.deepEqual(CHILD_TOOL_NAMES, ["read", "bash", "grep", "find", "ls", "web_research", "web_fetch"]);
		assert.equal(CHILD_TOOL_NAMES.includes("edit" as never), false);
		assert.equal(CHILD_TOOL_NAMES.includes("write" as never), false);
		assert.equal(CHILD_TOOL_NAMES.includes("subagents" as never), false);
	});

	it("maps parent modes to child mode flags", () => {
		assert.equal(childModeFlagForParentMode("research"), "--research");
		assert.equal(childModeFlagForParentMode("plan"), "--research");
		assert.equal(childModeFlagForParentMode("brainstorming"), "--brainstorming");
		assert.equal(childModeNameForParentMode("plan"), "research");
	});

	it("allows subagents from research, plan, and brainstorming modes only", () => {
		assert.equal(isSubagentParentMode("research"), true);
		assert.equal(isSubagentParentMode("plan"), true);
		assert.equal(isSubagentParentMode("brainstorming"), true);
		assert.equal(isSubagentParentMode("normal"), false);
		assert.equal(isSubagentParentMode("auto"), false);
	});

	it("adds plan-mode handoff guidance without asking child to write the plan", () => {
		const prompt = buildSubagentPrompt("plan", "Find risks", "Risk scout");
		assert.match(prompt, /Parent mode is plan/);
		assert.match(prompt, /do not write or persist the final implementation plan/);
		assert.match(prompt, /research-gated tools/);
		assert.match(prompt, /Bash is available through the research gate/);
		assert.match(prompt, /Do not intentionally modify files/);
		assert.match(prompt, /Risk scout/);
		assert.match(prompt, /Find risks/);
	});

	it("clamps concurrency", () => {
		assert.equal(clampConcurrency(undefined, 10), 4);
		assert.equal(clampConcurrency(99, 10), 4);
		assert.equal(clampConcurrency(2, 10), 2);
		assert.equal(clampConcurrency(0, 10), 1);
		assert.equal(clampConcurrency(4, 2), 2);
	});

	it("truncates output by bytes", () => {
		const output = truncateTaskOutput("abcdef", 3);
		assert.match(output, /^abc/);
		assert.match(output, /Output truncated/);
	});

	it("ignores malformed JSON mode events", () => {
		const result = emptyResult();
		assert.equal(applyJsonEventToResult(result, "not json"), false);
		assert.equal(
			applyJsonEventToResult(
				result,
				JSON.stringify({ type: "message_end", message: { role: "assistant", content: "not-array" } }),
			),
			false,
		);
		assert.equal(result.messages.length, 0);
	});

	it("handles malformed stored messages defensively", () => {
		const messages = [
			{ role: "assistant", content: "not-array" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "subagents/utils.ts" } }] },
			{ role: "assistant", content: [{ type: "text", text: "final" }] },
		] as never;

		assert.equal(getFinalOutput(messages), "final");
		assert.deepEqual(getToolCalls(messages), [{ name: "read", arguments: { path: "subagents/utils.ts" } }]);
	});

	it("marks aggregate subagent results as error only when all children fail", () => {
		const success = { ...emptyResult(), exitCode: 0 };
		const failed = { ...emptyResult(), exitCode: 1, stopReason: "error" };
		assert.equal(shouldMarkSubagentsError([success, failed]), false);
		assert.equal(shouldMarkSubagentsError([failed]), true);
		assert.equal(shouldMarkSubagentsError([]), false);
	});

	it("parses JSON mode message_end events and accumulates usage", () => {
		const result = emptyResult();
		const changed = applyJsonEventToResult(
			result,
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-test",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 2,
						cacheWrite: 1,
						totalTokens: 18,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			}),
		);

		assert.equal(changed, true);
		assert.equal(result.messages.length, 1);
		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 10);
		assert.equal(result.usage.output, 5);
		assert.equal(result.usage.cacheRead, 2);
		assert.equal(result.usage.cacheWrite, 1);
		assert.equal(result.usage.contextTokens, 18);
		assert.equal(result.usage.cost, 0.01);
		assert.equal(result.model, "claude-test");
	});
});
