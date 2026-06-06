import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGroomingModePrompt } from "../modes/grooming/prompts.ts";
import { buildPlanModePrompt } from "../modes/plan/prompts.ts";

function assertSharedBrainstormingGuidance(prompt: string): void {
	assert.match(prompt, /Research\/inspect project context/i);
	assert.match(prompt, /one focused clarifying question at a time/i);
	assert.match(prompt, /2-3 viable approaches/i);
	assert.match(prompt, /tradeoffs/i);
	assert.match(prompt, /YAGNI/i);
	assert.match(prompt, /avoid premature implementation/i);
	assert.match(prompt, /Assess scope early/i);
	assert.match(prompt, /help decompose/i);
	assert.match(prompt, /success criteria/i);
	assert.match(prompt, /non-goals/i);
	assert.match(prompt, /Stress-test/i);
}

describe("mode prompt builders", () => {
	it("builds a self-contained plan prompt with verification guidance", () => {
		const prompt = buildPlanModePrompt();

		assert.match(prompt, /self-contained markdown plan document/i);
		assert.match(prompt, /another agent can understand the whole assignment by reading only the plan file/i);
		assert.match(prompt, /Context/);
		assert.match(prompt, /Goal/);
		assert.match(prompt, /Assumptions/);
		assert.match(prompt, /Risks/);
		assert.match(prompt, /Open questions/);
		assert.match(prompt, /Plan:/);
		assert.match(prompt, /How to verify/);
		assert.match(prompt, /do not emit a draft plan/i);
		assert.match(prompt, /interactive question tool/i);
		assert.match(prompt, /plan_question/);
		assert.match(prompt, /2-4 concrete answer choices/i);
		assert.match(prompt, /benefits, caveats/i);
		assert.match(prompt, /recommended choice/i);
		assert.match(prompt, /built-in handling/i);
		assert.doesNotMatch(prompt, /Include a custom\/other option/i);
		assert.match(prompt, /concrete, user-answerable questions/i);
		assert.match(prompt, /write exactly "None known"/i);
		assert.match(prompt, /tests, linters, typechecks, commands, or manual checks/i);
		assert.match(prompt, /expected success signal/i);
	});

	it("uses shared research-first brainstorming guidance in plan mode", () => {
		const prompt = buildPlanModePrompt();

		assertSharedBrainstormingGuidance(prompt);
		assert.match(prompt, /same research-first brainstorming phase as grooming mode/i);
		assert.match(prompt, /final implementation plan artifact/i);
		assert.match(prompt, /major alternatives/i);
		assert.match(prompt, /enough context has been inspected/i);
		assert.match(prompt, /unresolved questions are either answered or explicitly captured/i);
	});

	it("discourages premature implementation in plan mode", () => {
		const prompt = buildPlanModePrompt();

		assert.match(prompt, /read-only/i);
		assert.match(prompt, /Do not modify code files or run state-changing commands/i);
		assert.match(prompt, /ask clarifying questions instead of emitting a final plan/i);
		assert.match(prompt, /Challenge gently/i);
	});

	it("includes active plan file guidance when planning", () => {
		const prompt = buildPlanModePrompt("plans/example.md");

		assert.match(prompt, /Active plan file: plans\/example\.md/);
		assert.match(prompt, /full updated markdown plan document/i);
		assert.match(prompt, /Changes made:/);
		assert.match(prompt, /incorporate new decisions, assumptions, risks, open questions, and revised implementation steps/i);
	});

	it("builds a brainstorming-focused grooming prompt", () => {
		const prompt = buildGroomingModePrompt("plans/example.md");

		assertSharedBrainstormingGuidance(prompt);
		assert.match(prompt, /brainstorming and feature-shaping mode/i);
		assert.match(prompt, /exploratory design notes/i);
		assert.match(prompt, /decisions/i);
		assert.match(prompt, /handoff notes for plan mode/i);
		assert.match(prompt, /Do not modify files or run state-changing commands/i);
		assert.match(prompt, /Active plan file: plans\/example\.md/);
		assert.match(prompt, /incorporate new decisions, assumptions, risks, open questions, and revised implementation direction/i);
	});

	it("keeps grooming exploratory instead of forcing a plan", () => {
		const prompt = buildGroomingModePrompt();

		assert.match(prompt, /Keep grooming distinct from plan mode/i);
		assert.match(prompt, /do not require an ordered implementation plan/i);
		assert.match(prompt, /ask the next best clarifying question instead of producing a premature plan/i);
	});
});
