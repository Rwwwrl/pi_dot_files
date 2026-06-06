export function buildAutoModePrompt(): string {
	return `[AUTOMODE ACTIVE]
Full tools are enabled. Ordinary workspace edits are allowed. Low-risk commands run directly; strictly dangerous operations are blocked; ambiguous/risky operations may be reviewed by a separate safety reviewer. Prefer small, reviewable changes and explain risky actions before taking them.`;
}
