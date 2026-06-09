import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAutoModePrompt } from "../modes/auto/prompts.ts";
import { buildBrainstormingModePrompt } from "../modes/brainstorming/prompts.ts";
import { buildNormalModePrompt } from "../modes/normal/prompts.ts";
import { buildPlanExecuteMessage } from "../modes/services.ts";
import { buildPlanModePrompt } from "../modes/plan/prompts.ts";
import { buildResearchModePrompt } from "../modes/research/prompts.ts";

function assertWebResearchGuidance(prompt: string): void {
	assert.match(prompt, /web_research/);
	assert.match(prompt, /web_fetch/);
	assert.match(prompt, /official documentation/i);
	assert.match(prompt, /Do not send secrets/i);
	assert.match(prompt, /private code/i);
	assert.match(prompt, /untrusted external content/i);
}

function assertInteractiveQuestionGuidance(prompt: string): void {
	assert.match(prompt, /Interactive question guidance/i);
	assert.match(prompt, /plan_question/);
	assert.match(prompt, /answer from the user to continue/i);
	assert.match(prompt, /blocking question in plain text/i);
	assert.match(prompt, /rhetorical or non-blocking questions/i);
}

function assertSharedBrainstormingGuidance(prompt: string): void {
	assert.match(prompt, /Design-thinking stance/i);
	assert.match(prompt, /do not jump straight to implementation details/i);
	assert.match(prompt, /Research\/inspect project context/i);
	assert.match(prompt, /one focused clarifying question at a time/i);
	assert.match(prompt, /group only tightly related decisions/i);
	assert.match(prompt, /2-3 viable approaches/i);
	assert.match(prompt, /non-trivial design decisions/i);
	assert.match(prompt, /tradeoffs/i);
	assert.match(prompt, /YAGNI/i);
	assert.match(prompt, /avoid premature implementation/i);
	assert.match(prompt, /Assess scope early/i);
	assert.match(prompt, /help decompose/i);
	assert.match(prompt, /success criteria/i);
	assert.match(prompt, /non-goals/i);
	assert.match(prompt, /Stress-test/i);
	assert.match(prompt, /Keep the loop lightweight/i);
}

describe("mode prompt builders", () => {
	it("builds a research-focused prompt", () => {
		const prompt = buildResearchModePrompt();

		assert.match(prompt, /RESEARCH MODE ACTIVE/);
		assert.match(prompt, /read-only, research-gated mode/i);
		assert.match(prompt, /understanding code, reviewing behavior, tracing architecture/i);
		assert.match(prompt, /Do not modify files or intentionally change filesystem, git, package, process, or remote state/i);
		assert.match(prompt, /research\/touch-ground commands through the research gate/i);
		assert.match(prompt, /Inspect relevant files/i);
		assert.match(prompt, /concrete evidence with file paths/i);
		assert.match(prompt, /code-flow notes/i);
		assert.match(prompt, /do not produce an implementation plan unless the user asks/i);
		assertInteractiveQuestionGuidance(prompt);
		assertWebResearchGuidance(prompt);
	});

	it("builds a normal prompt with interactive question guidance", () => {
		const prompt = buildNormalModePrompt();

		assert.match(prompt, /NORMAL MODE ACTIVE/);
		assertInteractiveQuestionGuidance(prompt);
	});

	it("builds an explicit plan execution handoff", () => {
		const message = buildPlanExecuteMessage("plans/example.md");

		assert.match(message, /Read plans\/example\.md/);
		assert.match(message, /execute its implementation steps in auto mode/i);
		assert.match(message, /verification guidance/i);
		assert.match(message, /small and reviewable/i);
	});

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
		assertInteractiveQuestionGuidance(prompt);
		assertWebResearchGuidance(prompt);
	});

	it("uses shared research-first brainstorming guidance in plan mode", () => {
		const prompt = buildPlanModePrompt();

		assertSharedBrainstormingGuidance(prompt);
		assert.match(prompt, /same design-thinking loop as brainstorming mode/i);
		assert.match(prompt, /final implementation plan artifact/i);
		assert.match(prompt, /design-shaping stage/i);
		assert.match(prompt, /before producing implementation steps/i);
		assert.match(prompt, /major alternatives/i);
		assert.match(prompt, /enough context has been inspected/i);
		assert.match(prompt, /unresolved questions are either answered or explicitly captured/i);
	});

	it("discourages premature implementation in plan mode", () => {
		const prompt = buildPlanModePrompt();

		assert.match(prompt, /research, brainstorm, and produce/i);
		assert.match(prompt, /Do not modify code files or intentionally change filesystem, git, package, process, or remote state/i);
		assert.match(prompt, /research\/touch-ground commands through the research gate/i);
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

	it("builds a brainstorming-focused prompt", () => {
		const prompt = buildBrainstormingModePrompt("plans/example.md");

		assertSharedBrainstormingGuidance(prompt);
		assertInteractiveQuestionGuidance(prompt);
		assert.match(prompt, /brainstorming and feature-shaping mode/i);
		assert.match(prompt, /research\/touch-ground commands through the research gate/i);
		assert.match(prompt, /exploratory design notes/i);
		assert.match(prompt, /decisions/i);
		assert.match(prompt, /handoff notes for plan mode/i);
		assert.match(prompt, /Do not modify files or intentionally change filesystem, git, package, process, or remote state/i);
		assert.match(prompt, /Active plan file: plans\/example\.md/);
		assert.match(prompt, /incorporate new decisions, assumptions, risks, open questions, and revised implementation direction/i);
		assertWebResearchGuidance(prompt);
	});

	it("builds an auto prompt with web research guidance", () => {
		const prompt = buildAutoModePrompt();

		assert.match(prompt, /AUTOMODE ACTIVE/);
		assertInteractiveQuestionGuidance(prompt);
		assertWebResearchGuidance(prompt);
	});

	it("keeps brainstorming exploratory instead of forcing a plan", () => {
		const prompt = buildBrainstormingModePrompt();

		assert.match(prompt, /Keep brainstorming distinct from plan mode/i);
		assert.match(prompt, /converge on design decisions and handoff notes/i);
		assert.match(prompt, /not ordered implementation steps/i);
		assert.match(prompt, /summarize the accepted direction/i);
		assert.match(prompt, /ask the next best clarifying question instead of producing a premature plan/i);
	});
});
