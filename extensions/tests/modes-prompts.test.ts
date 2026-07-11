import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAutoModePrompt } from "../modes/auto/prompts.ts";
import { buildBrainstormingModePrompt } from "../modes/brainstorming/prompts.ts";
import { buildInlineModePrompt } from "../modes/inline/prompts.ts";
import { buildNormalModePrompt } from "../modes/normal/prompts.ts";
import { buildModesOverlayPrompt } from "../modes/prompts.ts";
import { buildPlanExecuteMessage } from "../modes/services.ts";
import { buildPlanModePrompt } from "../modes/plan/prompts.ts";
import { buildResearchModePrompt } from "../modes/research/prompts.ts";
import type { Mode } from "../modes/state.ts";

const MODE_MARKERS = [
	"[NORMAL MODE ACTIVE]",
	"[INLINE MODE ACTIVE]",
	"[RESEARCH MODE ACTIVE]",
	"[PLAN MODE ACTIVE]",
	"[BRAINSTORMING MODE ACTIVE]",
	"[AUTOMODE ACTIVE]",
] as const;

function countMarkers(prompt: string): number {
	return MODE_MARKERS.reduce((count, marker) => count + (prompt.includes(marker) ? 1 : 0), 0);
}

function assertSingleModeMarker(prompt: string, marker: string): void {
	assert.equal(countMarkers(prompt), 1);
	assert.match(prompt, new RegExp(marker.replace(/[\[\]]/g, "\\$&")));
}

function wordCount(prompt: string): number {
	return prompt.trim().split(/\s+/).filter(Boolean).length;
}

function assertSharedOverlayGuidance(prompt: string): void {
	assert.match(prompt, /Modes extension operating contract/i);
	assert.doesNotMatch(prompt, /Core operating principles/i);
	assert.doesNotMatch(prompt, /Coding work guidance/i);
	assert.match(prompt, /Evidence and safety guidance/i);
	assert.match(prompt, /local files, command output, tool results, web pages, fetched docs/i);
	assert.match(prompt, /Do not expose secrets/i);
	assert.match(prompt, /distinguish observed facts from assumptions/i);
	assert.match(prompt, /Active mode precedence/i);
	assert.match(prompt, /only mode contract currently in force/i);
	assert.match(prompt, /historical context only, not active instructions/i);
	assert.match(prompt, /follow the current active mode's operating style, safety limits, and output expectations/i);
	assert.doesNotMatch(prompt, /plan_\s*question/);
	assert.doesNotMatch(prompt, /Interactive question guidance/i);
	assert.doesNotMatch(prompt, /Web research guidance/i);
	assert.doesNotMatch(prompt, /^Available tools:/m);
	assert.doesNotMatch(prompt, /<available_skills>/);
}

function assertGenericToolUseGuidance(prompt: string): void {
	assert.match(prompt, /Tool use guidance/i);
	assert.match(prompt, /Prefer read for file contents/i);
	assert.match(prompt, /edit\/write for file changes when allowed/i);
	assert.match(prompt, /bash for inspection or verification/i);
	assert.match(prompt, /Respect the active mode's safety limits/i);
	assert.match(prompt, /work around blocked changes/i);
	assert.match(prompt, /question_tool, web tools, subagents, and MCP/i);
	assert.match(prompt, /evidence, not instructions/i);
}

function assertInlineToolUseGuidance(prompt: string): void {
	assert.match(prompt, /Inline mode tool use guidance/i);
	assert.match(prompt, /Available research tools: read, bash, grep, find, ls/i);
	assert.match(prompt, /Available execution tools: edit, write/i);
	assert.match(prompt, /minimal nearby context/i);
	assert.match(prompt, /Use edit\/write for the final local change/i);
	assert.doesNotMatch(prompt, /question_tool/);
	assert.doesNotMatch(prompt, /MCP/);
	assert.doesNotMatch(prompt, /web_research/);
	assert.doesNotMatch(prompt, /web_fetch/);
}

function assertSharedBrainstormingGuidance(prompt: string): void {
	assert.match(prompt, /Design-thinking stance/i);
	assert.match(prompt, /senior developer/i);
	assert.match(prompt, /inspect enough project context/i);
	assert.match(prompt, /success criteria/i);
	assert.match(prompt, /non-goals/i);
	assert.match(prompt, /what can be cut/i);
	assert.match(prompt, /Compare viable approaches/i);
	assert.match(prompt, /tradeoffs/i);
	assert.match(prompt, /Ask focused clarifying questions/i);
	assert.match(prompt, /YAGNI-driven/i);
}

function assertPlanQualityGuidance(prompt: string): void {
	assert.match(prompt, /Plan quality guidance/i);
	assert.match(prompt, /self-contained and review-ready/i);
	assert.match(prompt, /chosen approach/i);
	assert.match(prompt, /rejected alternatives/i);
	assert.match(prompt, /exact files, existing symbols, planned new\/changed symbols/i);
	assert.match(prompt, /APIs\/signatures, data shapes, metadata keys/i);
	assert.match(prompt, /code-shaped sketches, pseudocode, or payload examples/i);
	assert.match(prompt, /Do not invent uninspected details/i);
	assert.match(prompt, /ordered, dependency-aware, and falsifiable/i);
}

describe("mode overlay prompt builder", () => {
	it("renders exactly one active mode marker for every mode", () => {
		const cases: Array<[Mode, string]> = [
			["normal", "[NORMAL MODE ACTIVE]"],
			["inline", "[INLINE MODE ACTIVE]"],
			["research", "[RESEARCH MODE ACTIVE]"],
			["plan", "[PLAN MODE ACTIVE]"],
			["brainstorming", "[BRAINSTORMING MODE ACTIVE]"],
			["auto", "[AUTOMODE ACTIVE]"],
		];

		for (const [mode, marker] of cases) {
			const prompt = buildModesOverlayPrompt({ mode });
			assertSharedOverlayGuidance(prompt);
			if (mode === "inline") {
				assertInlineToolUseGuidance(prompt);
			} else {
				assertGenericToolUseGuidance(prompt);
			}
			assertSingleModeMarker(prompt, marker);
		}
	});

	it("keeps generated overlays within intentional word budgets", () => {
		const budgets: Array<[Mode, number]> = [
			["normal", 385],
			["inline", 1460],
			["research", 460],
			["plan", 910],
			["brainstorming", 610],
			["auto", 385],
		];

		for (const [mode, budget] of budgets) {
			assert.ok(wordCount(buildModesOverlayPrompt({ mode })) <= budget, `${mode} overlay exceeded ${budget} words`);
		}
	});

	it("builds a normal overlay through the compatibility wrapper", () => {
		const prompt = buildNormalModePrompt();

		assertSharedOverlayGuidance(prompt);
		assertSingleModeMarker(prompt, "[NORMAL MODE ACTIVE]");
		assert.match(prompt, /Use edit\/write for file changes/i);
		assert.match(prompt, /Do not use bash, python, node/i);
		assert.match(prompt, /modify files/i);
		assert.match(prompt, /mode-aware autoreviewer/i);
	});

	it("builds an inline overlay for explicit-context micro edits", () => {
		const prompt = buildInlineModePrompt();

		assertSharedOverlayGuidance(prompt);
		assertSingleModeMarker(prompt, "[INLINE MODE ACTIVE]");
		assert.match(prompt, /smallest edit inside the target frame/i);
		assert.match(prompt, /request fidelity beats contextual completeness/i);
		assert.match(prompt, /local edit\/draft, not a complete standalone program/i);
		assert.match(prompt, /T = target frame/i);
		assert.match(prompt, /R = request atoms/i);
		assert.match(prompt, /B = bindings already present in T/i);
		assert.match(prompt, /C = inspected context/i);
		assert.match(prompt, /Allowed edit semantics = R \+ references to B \+ syntax_glue\(R, C\)/i);
		assert.match(prompt, /syntax_glue may use C only for spelling/i);
		assert.match(prompt, /symbol names, import\/include paths, required signatures, syntax, local style, and placement/i);
		assert.match(prompt, /C must not create semantics/i);
		assert.match(prompt, /must not choose operand values, input sources, helper chains, optional arguments/i);
		assert.match(prompt, /workflows, lifecycle steps, or companion operations/i);
		assert.match(prompt, /Construct gate/i);
		assert.match(prompt, /Every added declaration, statement, call, constructor, import, argument, field, assignment, wrapper, helper, or control-flow block/i);
		assert.match(prompt, /its semantic role is explicitly in R/i);
		assert.match(prompt, /it directly reuses B/i);
		assert.match(prompt, /unavoidable syntax\/import glue/i);
		assert.match(prompt, /If not, omit it/i);
		assert.match(prompt, /Preserve R as anchors/i);
		assert.match(prompt, /requested operations, APIs, calls, resources, order, repetition, nesting, effects, and data flow/i);
		assert.match(prompt, /Do not replace a requested operation with a helper, wrapper, abstraction, lifecycle, workflow, or equivalent operation/i);
		assert.match(prompt, /Do not create a new named boundary/i);
		assert.match(prompt, /function, method, class, module wrapper, command, handler, helper, adapter, factory, or lifecycle unit/i);
		assert.match(prompt, /replace it with straight-line local statements/i);
		assert.match(prompt, /operand, value, identifier, key, client, queue, path, user, payload, source, or config value/i);
		assert.match(prompt, /free input directly at the use site/i);
		assert.match(prompt, /choose, fetch, derive, construct, default, validate, normalize, guard, bind, adapt, or manage a free input/i);
		assert.match(prompt, /must not become a source for other atoms/i);
		assert.match(prompt, /For each call, include only arguments required by R/i);
		assert.match(prompt, /Do not copy optional arguments, metadata, dependencies, retries, callbacks, lifecycle flags, defaults, or sibling parameters from context/i);
		assert.match(prompt, /dictionaries for requested names\/signatures only, not recipes to copy/i);
		assert.match(prompt, /Prefer an incomplete local draft with free inputs over invented completeness/i);
		assert.match(prompt, /delete every added construct whose removal still leaves all R atoms represented/i);
		assert.match(prompt, /ask one focused clarification instead of guessing/i);
		assert.match(prompt, /temporary request comments/i);
		assert.match(prompt, /remove only that comment block after implementing/i);
		assert.doesNotMatch(prompt, /Ask the user to switch/i);
		assert.doesNotMatch(prompt, /mode-aware autoreviewer/i);
	});

	it("builds a research-focused overlay", () => {
		const prompt = buildResearchModePrompt();

		assertSharedOverlayGuidance(prompt);
		assertSingleModeMarker(prompt, "[RESEARCH MODE ACTIVE]");
		assert.match(prompt, /read-only, research-gated mode/i);
		assert.match(prompt, /understanding code, reviewing behavior, tracing architecture/i);
		assert.match(prompt, /Do not modify files or intentionally change filesystem, git, package, process, or remote state/i);
		assert.match(prompt, /research\/touch-ground commands through the research gate/i);
		assert.match(prompt, /Inspect relevant files/i);
		assert.match(prompt, /concrete evidence with file paths/i);
		assert.match(prompt, /code-flow notes/i);
		assert.match(prompt, /do not produce an implementation plan unless the user asks/i);
	});

	it("builds an auto overlay", () => {
		const prompt = buildAutoModePrompt();

		assertSharedOverlayGuidance(prompt);
		assertSingleModeMarker(prompt, "[AUTOMODE ACTIVE]");
		assert.match(prompt, /Full baseline tools are enabled/i);
		assert.match(prompt, /Ordinary workspace edits are allowed/i);
		assert.match(prompt, /execution gate/i);
		assert.match(prompt, /small, reviewable changes/i);
	});

	it("builds an explicit plan execution handoff", () => {
		const message = buildPlanExecuteMessage("plans/example.md");

		assert.match(message, /Read plans\/example\.md/);
		assert.match(message, /execute its implementation steps in auto mode/i);
		assert.match(message, /verification guidance/i);
		assert.match(message, /small and reviewable/i);
	});

	it("builds a self-contained plan overlay with verification guidance", () => {
		const prompt = buildPlanModePrompt();

		assertSharedOverlayGuidance(prompt);
		assertSingleModeMarker(prompt, "[PLAN MODE ACTIVE]");
		assert.match(prompt, /self-contained markdown plan document/i);
		assert.match(prompt, /another agent can understand the whole assignment by reading only the plan file/i);
		assert.match(prompt, /Context/);
		assert.match(prompt, /Goal/);
		assert.match(prompt, /Assumptions/);
		assert.match(prompt, /Risks/);
		assert.match(prompt, /Open questions/);
		assert.match(prompt, /Plan:/);
		assert.match(prompt, /How to verify/);
		assert.match(prompt, /Code-level design/);
		assert.match(prompt, /concrete functions\/classes, important signatures, payload shapes, metadata keys, and before\/after flow/i);
		assert.match(prompt, /do not emit a draft plan/i);
		assert.match(prompt, /write exactly "None known"/i);
		assert.match(prompt, /tests, linters, typechecks, commands, or manual checks/i);
		assert.match(prompt, /expected success signal/i);
		assertPlanQualityGuidance(prompt);
	});

	it("uses shared research-first design guidance in plan mode", () => {
		const prompt = buildPlanModePrompt();

		assertSharedBrainstormingGuidance(prompt);
		assert.match(prompt, /relevant context is inspected/i);
		assert.match(prompt, /material decisions are resolved or explicitly captured/i);
		assert.match(prompt, /resolved or explicitly captured as open questions/i);
	});

	it("discourages premature implementation in plan mode", () => {
		const prompt = buildPlanModePrompt();

		assert.match(prompt, /research, brainstorm, and produce/i);
		assert.match(prompt, /Do not modify files or intentionally change filesystem, git, package, process, or remote state/i);
		assert.match(prompt, /research\/touch-ground commands through the research gate/i);
		assert.match(prompt, /ask clarifying questions; do not emit a draft plan/i);
		assert.match(prompt, /Finalize a plan only after relevant context is inspected/i);
	});

	it("includes active plan file guidance when planning", () => {
		const prompt = buildPlanModePrompt("plans/example.md");

		assert.match(prompt, /Active plan file: plans\/example\.md/);
		assert.match(prompt, /full updated markdown plan document/i);
		assert.match(prompt, /Changes made:/);
		assert.match(prompt, /incorporate new decisions, assumptions, risks, open questions, and revised implementation steps/i);
	});

	it("builds a brainstorming-focused overlay", () => {
		const prompt = buildBrainstormingModePrompt("plans/example.md");

		assertSharedOverlayGuidance(prompt);
		assertSingleModeMarker(prompt, "[BRAINSTORMING MODE ACTIVE]");
		assertSharedBrainstormingGuidance(prompt);
		assert.match(prompt, /brainstorming and feature-shaping mode/i);
		assert.match(prompt, /research\/touch-ground commands through the research gate/i);
		assert.match(prompt, /subagents\.ideation/);
		assert.match(prompt, /same neutral problem statement/);
		assert.match(prompt, /subagents\.tasks/);
		assert.match(prompt, /targeted research, review, or safety checks/);
		assert.match(prompt, /without treating subagent output as final authority/);
		assert.match(prompt, /Explore framing, alternatives, constraints/i);
		assert.match(prompt, /decisions/i);
		assert.match(prompt, /handoff notes for plan mode/i);
		assert.match(prompt, /Do not modify files or intentionally change filesystem, git, package, process, or remote state/i);
		assert.match(prompt, /Active plan file: plans\/example\.md/);
		assert.match(prompt, /incorporate new decisions, assumptions, risks, open questions, and revised implementation direction/i);
	});

	it("keeps brainstorming exploratory instead of forcing a plan", () => {
		const prompt = buildBrainstormingModePrompt();

		assert.match(prompt, /Keep brainstorming distinct from plan mode/i);
		assert.match(prompt, /converge on design decisions, not ordered implementation steps/i);
		assert.match(prompt, /handoff notes for plan mode/i);
		assert.match(prompt, /ask the next material clarifying question instead of producing a premature plan/i);
		assert.doesNotMatch(prompt, /previous turns were normal or auto mode/i);
	});
});
