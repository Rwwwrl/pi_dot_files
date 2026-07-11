import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { formatMessagesForReview, truncateForReview } from "../modes/review-context.ts";

function message(role: string, text: string): AgentMessage {
	return {
		role,
		content: [{ type: "text", text }],
	} as unknown as AgentMessage;
}

describe("AI reviewer context formatting", () => {
	it("formats resolved messages with role labels", () => {
		const formatted = formatMessagesForReview([
			message("user", "Please fix the issue and commit when done."),
			message("assistant", "I will make the change."),
		]);

		assert.match(formatted, /user: Please fix the issue and commit when done\./);
		assert.match(formatted, /assistant: I will make the change\./);
	});

	it("keeps summary-like resolved context messages", () => {
		const formatted = formatMessagesForReview([
			message("user", "[Compaction summary] User explicitly requested committing the finished typography changes."),
		]);

		assert.match(formatted, /Compaction summary/);
		assert.match(formatted, /requested committing/);
	});

	it("keeps only the most recent messages within the message limit", () => {
		const formatted = formatMessagesForReview(
			[message("user", "old"), message("assistant", "middle"), message("user", "new")],
			{ messageLimit: 2 },
		);

		assert.doesNotMatch(formatted, /old/);
		assert.match(formatted, /middle/);
		assert.match(formatted, /new/);
	});

	it("truncates individual messages and total formatted context", () => {
		const formatted = formatMessagesForReview([message("user", "a".repeat(50)), message("assistant", "b".repeat(50))], {
			perMessageLimit: 10,
			totalLimit: 60,
		});

		assert.ok(formatted.length <= 100);
		assert.match(formatted, /truncated/);
	});

	it("truncates plain review strings", () => {
		assert.equal(truncateForReview("abc", 10), "abc");
		assert.match(truncateForReview("abcdef", 3), /^abc\n\.\.\.\[truncated 3 chars\]$/);
	});
});
