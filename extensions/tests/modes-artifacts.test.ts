import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractNumberedSteps,
	extractPlanTitle,
	inferPlanTitle,
	slugify,
	summarizePlanChanges,
	shouldPersistPlanText,
} from "../modes/plan/artifacts.ts";

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

	it("summarizes numbered step changes", () => {
		assert.deepEqual(extractNumberedSteps("1. First\n2) Second"), ["First", "Second"]);
		assert.deepEqual(summarizePlanChanges("", "# Plan\n\nPlan:\n1. First\n2. Second\n"), [
			"Created a new plan with 2 steps.",
		]);
		assert.deepEqual(summarizePlanChanges("# Old\n\nPlan:\n1. First\n", "# New\n\nPlan:\n1. Better\n2. Added\n"), [
			'Renamed the plan from "Old" to "New".',
			'Updated step 1: "First" → "Better".',
			'Added step 2: "Added".',
		]);
	});
});
