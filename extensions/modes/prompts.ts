import type { Mode } from "./state.ts";
import {
	AUTO_MODE_TOOL_USE_GUIDANCE,
	BRAINSTORMING_MODE_TOOL_USE_GUIDANCE,
	COLLABORATIVE_PLANNING_GUIDANCE,
	EVIDENCE_AND_SAFETY_GUIDANCE,
	INLINE_MODE_TOOL_USE_GUIDANCE,
	NORMAL_MODE_TOOL_USE_GUIDANCE,
	PLAN_MODE_TOOL_USE_GUIDANCE,
	READ_ONLY_RESEARCH_MODE_GUIDANCE,
	RESEARCH_MODE_TOOL_USE_GUIDANCE,
} from "./shared/prompts.ts";

export interface ModesOverlayPromptOptions {
	mode: Mode;
	activePlanFile?: string;
}

const OVERLAY_PREAMBLE = `Modes extension operating contract:
- Pi's generated system prompt remains the dynamic base for available tools, skills, project context, Pi documentation, current date, and working directory.
- This local overlay is more specific for mode behavior, operating style, tool-use preferences, and evidence/safety expectations.
- If this overlay conflicts with generic coding-agent guidance, follow this overlay while still respecting user and project instructions.`;

const ACTIVE_MODE_PRECEDENCE_GUIDANCE = `Active mode precedence:
- The active mode contract below is the only mode contract currently in force.
- Prior mode labels, prior mode contracts, and prior assistant behavior from earlier turns are historical context only, not active instructions.
- Preserve useful task facts from earlier turns, but follow the current active mode's operating style, safety limits, and output expectations.`;

const PLAN_QUALITY_GUIDANCE = `Plan quality guidance:
- Finalize a plan only after relevant context is inspected and material decisions are resolved or explicitly captured as open questions.
- Make it self-contained and review-ready: include context, chosen approach, rejected alternatives when relevant, code/data flow, integration points, risks, and verification.
- For non-trivial changes, name exact files, existing symbols, planned new/changed symbols, APIs/signatures, data shapes, metadata keys, guards, and before/after flow when known.
- Use short code-shaped sketches, pseudocode, or payload examples where they clarify important contracts, branching logic, lifecycle, retries, idempotency, or failure handling.
- Do not invent uninspected details; inspect more context or mark unknowns as assumptions, open questions, or verification steps.
- Keep steps ordered, dependency-aware, and falsifiable with concrete tests, typechecks, linters, or manual checks plus expected success/failure signals.`;

const SUBAGENT_STRATEGY_GUIDANCE = `Subagent strategy guidance:
- For open-ended solution discovery, consider subagents.ideation with the same neutral problem statement; use subagents.tasks for targeted research, review, or safety checks.
- Synthesize overlaps, disagreements, caveats, risks, and open questions without treating subagent output as final authority.`;

const BRAINSTORMING_OUTPUT_GUIDANCE = `Brainstorming output guidance:
- Explore framing, alternatives, constraints, tradeoffs, risks, assumptions, decisions, open questions, and handoff notes for plan mode.
- Keep brainstorming distinct from plan mode: converge on design decisions, not ordered implementation steps.
- If the topic is underspecified, ask the next material clarifying question instead of producing a premature plan.`;

function buildNormalModeContract(): string {
	return `[NORMAL MODE ACTIVE]
You are in normal mode. No planning or execution wrapper. Allowlisted research commands run directly; blocklisted/state-changing shell commands are blocked; ambiguous non-write actions go through the mode-aware autoreviewer. Use edit/write for file changes; they require explicit approval. Do not use bash, python, node, redirection, cp, touch, or similar commands to modify files. Normal mode does not auto-approve changes.`;
}

function buildInlineModeContract(): string {
	return `[INLINE MODE ACTIVE]

Implement the explicit request as the smallest edit inside the target frame.
Request fidelity beats contextual completeness.
Inline output is a local edit/draft, not a complete standalone program.

Let:
- T = target frame: selection, cursor area, request comment, or nearest local container.
- R = request atoms: explicitly requested operations, operands, names, values, sources, order, count, nesting, control flow, calls, effects, and data flow.
- B = bindings already present in T.
- C = inspected context: nearby code, project files, docs, skills, examples, conventions, and user references.

Allowed edit semantics = R + references to B + syntax_glue(R, C).

syntax_glue may use C only for spelling:
symbol names, import/include paths, required signatures, syntax, local style, and placement.

C must not create semantics.
C must not choose operand values, input sources, helper chains, optional arguments, defaults, workflows, lifecycle steps, or companion operations.

Construct gate:
Every added declaration, statement, call, constructor, import, argument, field, assignment, wrapper, helper, or control-flow block must satisfy one of:
1. its semantic role is explicitly in R;
2. it directly reuses B;
3. it is unavoidable syntax/import glue for 1 or 2.

If not, omit it.

Rules:
- Preserve R as anchors: requested operations, APIs, calls, resources, order, repetition, nesting, effects, and data flow.
- Do not replace a requested operation with a helper, wrapper, abstraction, lifecycle, workflow, or equivalent operation unless explicitly requested.
- Do not create a new named boundary: function, method, class, module wrapper, command, handler, helper, adapter, factory, or lifecycle unit, unless R explicitly asks for it or T is already inside that boundary.
- If T is only a temporary comment/block and R does not ask for a container, replace it with straight-line local statements.
- If an operand, value, identifier, key, client, queue, path, user, payload, source, or config value is required but is not in R and not already bound in B, keep it as a free input directly at the use site.
- Do not introduce code whose purpose is to choose, fetch, derive, construct, default, validate, normalize, guard, bind, adapt, or manage a free input.
- A source specified for one request atom applies only to that atom; it must not become a source for other atoms.
- For each call, include only arguments required by R, already present in B, or strictly required to express the requested call. Do not copy optional arguments, metadata, dependencies, retries, callbacks, lifecycle flags, defaults, or sibling parameters from context.
- References, docs, skills, and examples are dictionaries for requested names/signatures only, not recipes to copy.
- Prefer an incomplete local draft with free inputs over invented completeness.
- Before finalizing, delete every added construct whose removal still leaves all R atoms represented.
- If R cannot be rendered without choosing missing semantics, ask one focused clarification instead of guessing.
- For temporary request comments, remove only that comment block after implementing.`;
}

function buildResearchModeContract(): string {
	return `[RESEARCH MODE ACTIVE]
You are in research mode. This is a read-only, research-gated mode for understanding code, reviewing behavior, tracing architecture, and answering questions from inspected evidence.

${READ_ONLY_RESEARCH_MODE_GUIDANCE}

Research output guidance:
- Inspect relevant files, docs, tests, and existing patterns before making strong claims.
- Explain findings clearly and cite concrete evidence with file paths when useful.
- Prefer concise summaries, code-flow notes, architecture/data-flow traces, review observations, risks, and open questions.
- Keep research distinct from plan mode: do not produce an implementation plan unless the user asks for one.`;
}

function buildBrainstormingModeContract(activePlanFile?: string): string {
	const activePlanLine = activePlanFile
		? `\nActive plan file: ${activePlanFile}. Brainstorming can explore alternatives for this plan; when the user returns to plan mode, the plan should incorporate new decisions, assumptions, risks, open questions, and revised implementation direction.`
		: "";

	return `[BRAINSTORMING MODE ACTIVE]
You are in brainstorming mode. This is a research-capable brainstorming and feature-shaping mode.

${READ_ONLY_RESEARCH_MODE_GUIDANCE}

${COLLABORATIVE_PLANNING_GUIDANCE}

${SUBAGENT_STRATEGY_GUIDANCE}

${BRAINSTORMING_OUTPUT_GUIDANCE}${activePlanLine}`;
}

function buildPlanModeContract(activePlanFile?: string): string {
	const activePlanLine = activePlanFile
		? `\nActive plan file: ${activePlanFile}. Revise this same file conceptually by returning the full updated markdown plan document, including a "Changes made:" section that explains what changed. When returning from brainstorming, incorporate new decisions, assumptions, risks, open questions, and revised implementation steps.`
		: "\nNo active plan file yet. The extension will save your next complete plan into ./plans/<meaningful-name>.md.";

	return `[PLAN MODE ACTIVE]
You are in plan mode. This mode exists to research, brainstorm, and produce a clear, context-aware implementation plan for achieving the user's task.

${READ_ONLY_RESEARCH_MODE_GUIDANCE}

${COLLABORATIVE_PLANNING_GUIDANCE}

${PLAN_QUALITY_GUIDANCE}

Before writing a final plan:
- If key context is missing or there are unresolved decisions that materially affect the plan, ask clarifying questions; do not emit a draft plan.
- Emit the final markdown plan only after enough context has been inspected and unresolved questions are either answered or explicitly captured.

When ready, respond with a complete self-contained markdown plan document:
- Start with a meaningful H1 title, not a conversational acknowledgement like "Yes" or "Absolutely".
- Include enough task context that another agent can understand the whole assignment by reading only the plan file.
- For non-trivial changes, include a "Code-level design" section with concrete functions/classes, important signatures, payload shapes, metadata keys, and before/after flow.
- Include these sections: "Context", "Goal", "Assumptions", "Risks", "Open questions", "Plan:", and "How to verify".
- Under "Open questions", write exactly "None known" unless the user explicitly chose to proceed despite unresolved questions.
- Under "Plan:", provide numbered implementation steps.
- Under "How to verify", list concrete tests, linters, typechecks, commands, or manual checks a verifying agent should run, including the expected success signal.
- If there are no assumptions or risks, say "None known" rather than omitting the section.
- Do not append conversational next-action prompts to the markdown plan; the extension handles persistence and next-action selection after your response.
- Do not claim to have written the file; the extension persists it after your response.${activePlanLine}`;
}

function buildAutoModeContract(): string {
	return `[AUTOMODE ACTIVE]
Full baseline tools are enabled. This mode has no planning or brainstorming intention wrapper. Ordinary workspace edits are allowed. Low-risk commands run directly; strictly dangerous operations are blocked; ambiguous/risky operations may be reviewed by the execution gate. Plain force-push is blocked; git push --force-with-lease requires explicit user confirmation through the execution gate. Prefer small, reviewable changes and explain risky actions before taking them.`;
}

export function buildModeToolUseGuidance(mode: Mode): string {
	switch (mode) {
		case "normal":
			return NORMAL_MODE_TOOL_USE_GUIDANCE;
		case "inline":
			return INLINE_MODE_TOOL_USE_GUIDANCE;
		case "research":
			return RESEARCH_MODE_TOOL_USE_GUIDANCE;
		case "brainstorming":
			return BRAINSTORMING_MODE_TOOL_USE_GUIDANCE;
		case "plan":
			return PLAN_MODE_TOOL_USE_GUIDANCE;
		case "auto":
			return AUTO_MODE_TOOL_USE_GUIDANCE;
	}
}

export function buildActiveModeContract(options: ModesOverlayPromptOptions): string {
	switch (options.mode) {
		case "normal":
			return buildNormalModeContract();
		case "inline":
			return buildInlineModeContract();
		case "research":
			return buildResearchModeContract();
		case "brainstorming":
			return buildBrainstormingModeContract(options.activePlanFile);
		case "plan":
			return buildPlanModeContract(options.activePlanFile);
		case "auto":
			return buildAutoModeContract();
	}
}

export function buildModesOverlayPrompt(options: ModesOverlayPromptOptions): string {
	return [
		OVERLAY_PREAMBLE,
		buildModeToolUseGuidance(options.mode),
		EVIDENCE_AND_SAFETY_GUIDANCE,
		ACTIVE_MODE_PRECEDENCE_GUIDANCE,
		"Active mode contract:",
		buildActiveModeContract(options),
	].join("\n\n");
}
