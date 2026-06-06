import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

const PLAN_QUESTION_PARAMETERS = {
	type: "object",
	properties: {
		question: { type: "string", description: "The planning question to ask." },
		options: {
			type: "array",
			description: "Concrete answer choices.",
			items: {
				type: "object",
				properties: {
					label: { type: "string", description: "Short option label." },
					description: {
						type: "string",
						description: "Benefits, caveats, and fit. Include 'Recommended:' when applicable.",
					},
				},
				required: ["label", "description"],
				additionalProperties: false,
			},
		},
		allowOther: {
			type: "boolean",
			description: "Deprecated; Other/custom is always included with inline typing.",
		},
	},
	required: ["question", "options"],
	additionalProperties: false,
} as ToolDefinition["parameters"];

interface PlanQuestionParams {
	question: string;
	options: Array<{ label: string; description: string }>;
}

export function registerPlanQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "plan_question",
		label: "Plan Question",
		description:
			"Ask the user a planning clarification with concrete choices, benefits, caveats, and an optional recommendation before writing a plan.",
		promptSnippet: "Ask a choice-based planning clarification before emitting a plan",
		promptGuidelines: [
			"Use plan_question in plan mode when an answer materially affects the plan; do not write the plan until the answer is known.",
			"For plan_question options, include benefits, caveats, and mark the recommended option when appropriate.",
			"plan_question always includes an Other/custom option with inline typing, so do not add your own custom option.",
		],
		parameters: PLAN_QUESTION_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as PlanQuestionParams;
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "UI is not available to ask the planning question." }],
					details: { question: typed.question, answer: null },
				};
			}

			const options = [...typed.options, { label: "Other/custom", description: "Type a different answer." }];
			if (ctx.mode !== "tui") {
				const labels = options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`);
				const selected = await ctx.ui.select(typed.question, labels);
				if (!selected) {
					return {
						content: [{ type: "text", text: "User cancelled the planning question." }],
						details: { question: typed.question, answer: null },
					};
				}

				const selectedIndex = labels.indexOf(selected);
				if (selectedIndex === options.length - 1) {
					const customAnswer = (await ctx.ui.input("Other/custom answer", "Type a different answer"))?.trim();
					if (!customAnswer) {
						return {
							content: [{ type: "text", text: "User cancelled the planning question." }],
							details: { question: typed.question, answer: null },
						};
					}
					return {
						content: [{ type: "text", text: `User answered planning question: ${customAnswer}` }],
						details: { question: typed.question, answer: customAnswer, wasCustom: true },
					};
				}

				return {
					content: [{ type: "text", text: `User answered planning question: ${selected}` }],
					details: { question: typed.question, answer: selected, wasCustom: false },
				};
			}

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean } | null>((tui, theme, _kb, done) => {
				let optionIndex = 0;
				let inputMode = false;
				let cachedLines: string[] | undefined;

				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				editor.onSubmit = (value) => {
					const answer = value.trim();
					if (answer) {
						done({ answer, wasCustom: true });
						return;
					}
					inputMode = false;
					editor.setText("");
					refresh();
				};

				return {
					get focused() {
						return editor.focused;
					},
					set focused(value: boolean) {
						editor.focused = value;
					},
					handleInput(data: string): void {
						if (inputMode) {
							if (matchesKey(data, Key.escape)) {
								inputMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(options.length - 1, optionIndex + 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							const selected = options[optionIndex];
							if (optionIndex === options.length - 1) {
								inputMode = true;
								refresh();
								return;
							}
							done({ answer: `${optionIndex + 1}. ${selected.label} — ${selected.description}`, wasCustom: false });
							return;
						}
						if (matchesKey(data, Key.escape)) {
							done(null);
						}
					},
					render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (line: string) => lines.push(truncateToWidth(line, width));

						add(theme.fg("accent", typed.question));
						lines.push("");
						for (let index = 0; index < options.length; index++) {
							const option = options[index];
							const selected = index === optionIndex;
							const prefix = selected ? theme.fg("accent", "→ ") : "  ";
							const color = selected ? "accent" : "text";
							add(`${prefix}${theme.fg(color, `${index + 1}. ${option.label}`)}${inputMode && selected ? " ✎" : ""}`);
							add(`   ${theme.fg("muted", option.description)}`);
						}

						if (inputMode) {
							lines.push("");
							add(theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, width - 2))) {
								add(` ${line}`);
							}
							lines.push("");
							add(theme.fg("dim", "Enter submit • Esc back to choices"));
						} else {
							lines.push("");
							add(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
						}

						cachedLines = lines;
						return lines;
					},
					invalidate(): void {
						cachedLines = undefined;
					},
				};
			});

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the planning question." }],
					details: { question: typed.question, answer: null },
				};
			}

			return {
				content: [{ type: "text", text: `User answered planning question: ${result.answer}` }],
				details: { question: typed.question, answer: result.answer, wasCustom: result.wasCustom },
			};
		},
		renderShell: "self",
		renderCall() {
			return new Container();
		},
		renderResult(result, _options, theme) {
			const details = result.details as { answer?: unknown } | undefined;
			const answer = typeof details?.answer === "string" ? details.answer : undefined;
			if (!answer) return new Container();
			return new Text(theme.fg("success", "Got answer: ") + theme.fg("muted", answer), 0, 0);
		},
	});
}
