import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractPlanTitle,
	inferPlanTitle,
	slugify,
	shouldPersistPlanText,
} from "../modes/repositories.ts";

describe("plan artifact helpers", () => {
	it("slugifies plan titles into stable filenames", () => {
		assert.equal(slugify("Refactor `modes/` with Hybrid Technical Layering"), "refactor-modes-with-hybrid-technical-layering");
		assert.equal(slugify("!!!"), "plan");
	});

	it("extracts and infers plan titles", () => {
		assert.equal(extractPlanTitle("# **Refactor modes**\n\nPlan:\n1. Work"), "Refactor modes");
		assert.equal(extractPlanTitle("Title: `Plan artifacts`\n\nPlan:\n1. Work"), "Plan artifacts");
		assert.equal(inferPlanTitle("User requested work\nmore", "No title"), "User requested work");
	});

	it("detects complete plan text", () => {
		assert.equal(shouldPersistPlanText("Plan:\n1. Do work"), true);
		assert.equal(shouldPersistPlanText("# Title\n\n1. Do work"), true);
		assert.equal(shouldPersistPlanText("Here are some ideas"), false);
	});
});
