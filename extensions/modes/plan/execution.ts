export function buildPlanExecutionPrompt(activePlanFile?: string): string {
	const planFileLine = activePlanFile
		? `\nPlan file: ${activePlanFile}\nRead this file first, then execute the plan it contains.`
		: "\nNo plan file is available; execute the latest saved plan context if it is available in the conversation.";

	return `[AUTOMODE ACTIVE - EXECUTING PLAN]
Full tools are enabled. Ordinary workspace edits are allowed; dangerous operations are blocked or reviewed by a separate safety reviewer.
${planFileLine}

Work through the plan carefully in order. When you finish, summarize what changed and how you verified it. Do not emit internal progress markers.`;
}

export function buildPlanExecuteMessage(activePlanFile?: string): string {
	const planFileLine = activePlanFile ? ` from ${activePlanFile}` : "";
	return `Execute the plan${planFileLine} in auto mode.`;
}
