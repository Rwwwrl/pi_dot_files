import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const QUESTION_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		question: { type: "string", description: "The question to ask." },
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

interface QuestionToolParams {
	question: string;
	options: Array<{ label: string; description: string }>;
}

export function registerQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "question_tool",
		label: "Ask Question",
		description:
			"Ask the user an interactive question with concrete choices, benefits, caveats, and an optional recommendation.",
		promptSnippet: "Ask a choice-based user question before proceeding when input is needed",
		parameters: QUESTION_TOOL_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionToolParams;
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "UI is not available to ask the question." }],
					details: { question: typed.question, answer: null },
				};
			}

			const options = [...typed.options, { label: "Other/custom", description: "Type a different answer." }];
			if (ctx.mode !== "tui") {
				const labels = options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`);
				const selected = await ctx.ui.select(typed.question, labels);
				if (!selected) {
					return {
						content: [{ type: "text", text: "User cancelled the question." }],
						details: { question: typed.question, answer: null },
					};
				}

				const selectedIndex = labels.indexOf(selected);
				if (selectedIndex === options.length - 1) {
					const customAnswer = (await ctx.ui.input("Other/custom answer", "Type a different answer"))?.trim();
					if (!customAnswer) {
						return {
							content: [{ type: "text", text: "User cancelled the question." }],
							details: { question: typed.question, answer: null },
						};
					}
					return {
						content: [{ type: "text", text: `User answered question: ${customAnswer}` }],
						details: { question: typed.question, answer: customAnswer, wasCustom: true },
					};
				}

				return {
					content: [{ type: "text", text: `User answered question: ${selected}` }],
					details: { question: typed.question, answer: selected, wasCustom: false },
				};
			}

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean } | null>((tui, theme, _kb, done) => {
				let optionIndex = 0;
				let inputMode = false;
				let cachedLines: string[] | undefined;
				let cachedWidth: number | undefined;

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
					cachedWidth = undefined;
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
						if (cachedLines && cachedWidth === width) return cachedLines;

						const lines: string[] = [];
						const addRaw = (line: string) => lines.push(truncateToWidth(line, width, ""));
						const addWrapped = (text: string, prefix = "", continuationPrefix = prefix) => {
							const maxPrefixWidth = Math.max(visibleWidth(prefix), visibleWidth(continuationPrefix));
							const wrapped = wrapTextWithAnsi(text, Math.max(1, width - maxPrefixWidth));
							for (let lineIndex = 0; lineIndex < wrapped.length; lineIndex++) {
								const currentPrefix = lineIndex === 0 ? prefix : continuationPrefix;
								lines.push(truncateToWidth(`${currentPrefix}${wrapped[lineIndex]}`, width, ""));
							}
						};

						addWrapped(theme.fg("accent", typed.question));
						lines.push("");
						for (let index = 0; index < options.length; index++) {
							const option = options[index];
							const selected = index === optionIndex;
							const prefix = selected ? theme.fg("accent", "→ ") : "  ";
							const color = selected ? "accent" : "text";
							const editSuffix = inputMode && selected ? " ✎" : "";
							addWrapped(theme.fg(color, `${index + 1}. ${option.label}${editSuffix}`), prefix, "  ");
							addWrapped(theme.fg("muted", option.description), "   ", "   ");
						}

						if (inputMode) {
							lines.push("");
							addWrapped(theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, width - 2))) {
								addRaw(` ${line}`);
							}
							lines.push("");
							addWrapped(theme.fg("dim", "Enter submit • Esc back to choices"));
						} else {
							lines.push("");
							addWrapped(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
						}

						cachedLines = lines;
						cachedWidth = width;
						return lines;
					},
					invalidate(): void {
						cachedLines = undefined;
						cachedWidth = undefined;
					},
				};
			});

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the question." }],
					details: { question: typed.question, answer: null },
				};
			}

			return {
				content: [{ type: "text", text: `User answered question: ${result.answer}` }],
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
