export function buildPlanExecuteMessage(activePlanFile?: string): string {
	if (activePlanFile) {
		return `Read ${activePlanFile}, then execute its implementation steps in auto mode. Follow the plan's verification guidance and keep changes small and reviewable.`;
	}
	return "Execute the latest saved plan in auto mode. Read the plan first, follow its verification guidance, and keep changes small and reviewable.";
}
