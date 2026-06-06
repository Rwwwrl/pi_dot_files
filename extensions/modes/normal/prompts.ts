export function buildNormalModePrompt(): string {
	return `[NORMAL MODE ACTIVE]
You are in normal mode. Safe inspection tools and allowlisted shell commands run directly. File changes, edit/write calls, non-read-only tools, secret reads, and unsafe or state-changing shell commands require explicit user approval through the permission prompt. There is no automode safety reviewer in this mode.`;
}
