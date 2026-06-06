/**
 * Tool and bash safety classification used by read-only modes, normal approvals,
 * and automode pre-review triage.
 */

export type SafetyDecision = "allow" | "deny" | "review";
export type PathAccess = "read" | "write";

export interface SafetyClassification {
	decision: SafetyDecision;
	reason: string;
}

// Irreversible or privilege-sensitive operations that automode should never run.
const STRICTLY_BLOCKED_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\brm\s+[^\n;|&]*-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\n;|&]*(?:\s|=)(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*)(?:\s|$)/i, reason: "recursive force removal of a root/home path is destructive" },
	{ pattern: /\bgit\s+reset\b[^\n;|&]*\s--hard\b/i, reason: "git reset --hard can irreversibly discard work" },
	{ pattern: /\bgit\s+clean\b[^\n;|&]*\s-[^\s]*[fdx][^\s]*/i, reason: "git clean with force/delete flags can remove untracked work" },
	{ pattern: /\bgit\s+push\b[^\n;|&]*\s--force(?:-with-lease)?\b/i, reason: "force pushing rewrites remote history" },
	{ pattern: /\b(?:sudo|su)\b/i, reason: "privilege escalation is not allowed in automode" },
	{ pattern: /\b(?:mkfs|fdisk|parted|diskutil\s+erase|diskutil\s+partition|mount|umount)\b/i, reason: "disk/partition operations are not allowed" },
	{ pattern: /\bdd\b[^\n;|&]*\bof=\/dev\//i, reason: "writing raw data to devices is destructive" },
	{ pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: "system power commands are not allowed" },
	{ pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/, reason: "fork bombs are not allowed" },
	{ pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b/i, reason: "piping downloaded code into a shell is not allowed" },
	{ pattern: /\b(?:npm|yarn|pnpm)\s+publish\b/i, reason: "publishing packages is not allowed in automode" },
];

const PROTECTED_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /(^|\/)\.git(?:\/|$)/, reason: "direct access to .git internals is not allowed" },
	{ pattern: /(^|\/)\.ssh\/(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/, reason: "SSH private key files are protected" },
	{ pattern: /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/, reason: "SSH private key files are protected" },
];

const SENSITIVE_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /(^|\/)\.env(?:$|\.[^/]+$)/, reason: "environment files can contain secrets" },
	{ pattern: /(^|\/)\.npmrc$/, reason: "npm config files can contain tokens" },
	{ pattern: /(^|\/)\.pypirc$/, reason: "Python package config files can contain tokens" },
	{ pattern: /(^|\/)\.netrc$/, reason: "netrc files can contain credentials" },
	{ pattern: /(^|\/)credentials(?:\.[^/]+)?$/i, reason: "credential files are sensitive" },
	{ pattern: /(^|\/)secrets?(?:\.[^/]+)?$/i, reason: "secret files are sensitive" },
	{ pattern: /(^|\/)(?:api[-_]?keys?|tokens?|auth[-_]?tokens?)\.(?:json|ya?ml|toml|ini|env|txt)$/i, reason: "token/key files are sensitive" },
	{ pattern: /(^|\/)(?:[^/]+\.)?(?:pem|key)$/, reason: "key material files are sensitive" },
	{ pattern: /(^|\/)\.kube\/config$/, reason: "Kubernetes config can contain credentials" },
	{ pattern: /(^|\/)config\/credentials(?:\.[^/]+)?$/i, reason: "credential config files are sensitive" },
];

const SENSITIVE_COMMAND_TEXT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /(^|[\s"'=\/])\.env(?:$|[\s"'/.])/i, reason: "command references an environment file that can contain secrets" },
	{ pattern: /(^|[\s"'=\/])\.npmrc(?:$|[\s"'])/i, reason: "command references npm config that can contain tokens" },
	{ pattern: /(^|[\s"'=\/])\.pypirc(?:$|[\s"'])/i, reason: "command references Python package config that can contain tokens" },
	{ pattern: /(^|[\s"'=\/])\.netrc(?:$|[\s"'])/i, reason: "command references netrc credentials" },
	{ pattern: /(^|[\s"'=\/])(?:\.ssh\/)?(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:$|[\s"'])/i, reason: "command references an SSH private key" },
	{ pattern: /(^|[\s"'=])\.git\//i, reason: "command references .git internals" },
	{ pattern: /(^|[\s"'=\/])(?:credentials|secrets?)(?:\.[^\s"']+)?(?:$|[\s"'])/i, reason: "command references a credential or secret file" },
	{ pattern: /(^|[\s"'=\/])(?:api[-_]?keys?|tokens?|auth[-_]?tokens?)\.(?:json|ya?ml|toml|ini|env|txt)(?:$|[\s"'])/i, reason: "command references a token/key file" },
];

// State-changing commands blocked in read-only modes and reviewed in automode.
const STATE_CHANGING_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\brm\b/i, reason: "rm changes filesystem state" },
	{ pattern: /\brmdir\b/i, reason: "rmdir changes filesystem state" },
	{ pattern: /\bmv\b/i, reason: "mv changes filesystem state" },
	{ pattern: /\bcp\b/i, reason: "cp changes filesystem state" },
	{ pattern: /\bmkdir\b/i, reason: "mkdir changes filesystem state" },
	{ pattern: /\btouch\b/i, reason: "touch changes filesystem state" },
	{ pattern: /\bchmod\b/i, reason: "chmod changes filesystem permissions" },
	{ pattern: /\bchown\b/i, reason: "chown changes filesystem ownership" },
	{ pattern: /\bchgrp\b/i, reason: "chgrp changes filesystem ownership" },
	{ pattern: /\bln\b/i, reason: "ln changes filesystem state" },
	{ pattern: /\btee\b/i, reason: "tee usually writes files" },
	{ pattern: /\btruncate\b/i, reason: "truncate changes filesystem state" },
	{ pattern: /\bdd\b/i, reason: "dd can write files or devices" },
	{ pattern: /\bshred\b/i, reason: "shred destroys file contents" },
	{ pattern: /(^|[^<])>(?!>)/, reason: "output redirection writes files" },
	{ pattern: />>/, reason: "append redirection writes files" },
	{ pattern: /\bfind\b[^\n;|&]*\s-delete\b/i, reason: "find -delete removes files" },
	{ pattern: /\bfind\b[^\n;|&]*\s-exec\b/i, reason: "find -exec can run arbitrary commands" },
	{ pattern: /\bsed\b[^\n;|&]*\s-i(?:\s|$|\.)/i, reason: "sed -i edits files in place" },
	{ pattern: /\bawk\b[^\n;|&]*\s-i\s+inplace\b/i, reason: "awk inplace mode edits files" },
	{ pattern: /\bperl\b[^\n;|&]*\s-pi\b/i, reason: "perl -pi edits files in place" },
	{ pattern: /\bxargs\b[^\n;|&]*\b(?:rm|rmdir|mv|cp|chmod|chown|chgrp|shred|truncate|tee)\b/i, reason: "xargs can run state-changing commands" },
	{ pattern: /\bcurl\b[^\n;|&]*(?:\s-o\s+\S|\s--output(?:=|\s+)|\s-O(?:\s|$)|\s--remote-name\b|\s-T\s+\S|\s--upload-file(?:=|\s+))/i, reason: "curl output/upload options write files or remote state" },
	{ pattern: /\bcurl\b[^\n;|&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b|\s-d\s+\S|\s--data(?:-raw|-binary|-urlencode)?(?:=|\s+)|\s-F\s+\S|\s--form(?:=|\s+)|\s--json(?:=|\s+))/i, reason: "curl request options can mutate remote state" },
	{ pattern: /\bwget\b[^\n;|&]*(?:\s-O\s+(?!-(?:\s|$))\S|\s--output-document(?:=|\s+)(?!-(?:\s|$))\S)/i, reason: "wget output options write files" },
	{ pattern: /\bnpm\s+audit\s+fix\b/i, reason: "npm audit fix changes dependencies" },
	{ pattern: /\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i, reason: "npm command changes dependencies or publishes packages" },
	{ pattern: /\byarn\s+(add|remove|install|publish)\b/i, reason: "yarn command changes dependencies or publishes packages" },
	{ pattern: /\bpnpm\s+(add|remove|install|publish)\b/i, reason: "pnpm command changes dependencies or publishes packages" },
	{ pattern: /\bpip\s+(install|uninstall)\b/i, reason: "pip command changes Python packages" },
	{ pattern: /\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i, reason: "apt command changes system packages" },
	{ pattern: /\bbrew\s+(install|uninstall|upgrade)\b/i, reason: "brew command changes packages" },
	{ pattern: /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/i, reason: "git command changes repository state" },
	{ pattern: /\bsudo\b/i, reason: "sudo escalates privileges" },
	{ pattern: /\bsu\b/i, reason: "su escalates privileges" },
	{ pattern: /\bkill\b/i, reason: "kill changes process state" },
	{ pattern: /\bpkill\b/i, reason: "pkill changes process state" },
	{ pattern: /\bkillall\b/i, reason: "killall changes process state" },
	{ pattern: /\breboot\b/i, reason: "reboot changes system state" },
	{ pattern: /\bshutdown\b/i, reason: "shutdown changes system state" },
	{ pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i, reason: "systemctl command changes service state" },
	{ pattern: /\bservice\s+\S+\s+(start|stop|restart)\b/i, reason: "service command changes service state" },
	{ pattern: /\b(vim?|nano|emacs|code|subl)\b/i, reason: "interactive editors can modify files" },
];

// Safe read-only commands allowed in plan mode. These patterns intentionally do
// not allow shell composition; isSafeCommand rejects composition before matching.
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated)\b/i,
	/^\s*npm\s+audit(?:\s|$)(?!.*\bfix\b)/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python\s+--version\b/i,
	/^\s*curl\s+(?:-I|--head)\b/i,
	/^\s*wget\s+-O\s*-(?:\s|$)/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n\b/i,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

const AUTO_ALLOWED_COMMAND_PATTERNS = [
	...SAFE_PATTERNS,
	/^\s*(?:npm|yarn|pnpm)\s+(?:test|run\s+(?:test|build|lint|typecheck|check|format|format:check|validate)\b)/i,
	/^\s*(?:npx\s+)?(?:tsc|eslint|prettier|vitest|jest|mocha|ava|cargo\s+(?:test|check|build|fmt|clippy)|go\s+(?:test|build|vet|fmt)|pytest|ruff|mypy)\b/i,
	/^\s*make\s+(?:test|check|build|lint|format)\b/i,
	/^\s*git\s+(?:status|log|diff|show|branch|remote|config\s+--get|ls-files|grep|blame)\b/i,
];

function firstMatch(patterns: Array<{ pattern: RegExp; reason: string }>, value: string): string | undefined {
	return patterns.find((entry) => entry.pattern.test(value))?.reason;
}

function scanShellComposition(command: string): { hasNonPipelineComposition: boolean; pipelineParts?: string[] } {
	const parts = [""];
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let sawPipe = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		const next = command[index + 1];

		if (escaped) {
			parts[parts.length - 1] += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			parts[parts.length - 1] += char;
			escaped = true;
			continue;
		}

		if (quote === "single") {
			if (char === "'") quote = undefined;
			parts[parts.length - 1] += char;
			continue;
		}

		if (quote === "double") {
			if (char === '"') quote = undefined;
			if (char === "`" || (char === "$" && next === "(")) return { hasNonPipelineComposition: true };
			parts[parts.length - 1] += char;
			continue;
		}

		if (char === "'") {
			quote = "single";
			parts[parts.length - 1] += char;
			continue;
		}

		if (char === '"') {
			quote = "double";
			parts[parts.length - 1] += char;
			continue;
		}

		if (char === ";" || char === "`" || (char === "$" && next === "(") || (["<", ">"].includes(char) && next === "(")) {
			return { hasNonPipelineComposition: true };
		}

		if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
			return { hasNonPipelineComposition: true };
		}

		if (char === "|") {
			sawPipe = true;
			parts.push("");
			continue;
		}

		parts[parts.length - 1] += char;
	}

	const trimmedParts = parts.map((part) => part.trim());
	return {
		hasNonPipelineComposition: false,
		pipelineParts: sawPipe && trimmedParts.every(Boolean) ? trimmedParts : undefined,
	};
}

function findSensitiveCommandReference(command: string): string | undefined {
	return firstMatch(SENSITIVE_COMMAND_TEXT_PATTERNS, command.replace(/\\/g, "/"));
}

function classifySimpleBashCommand(command: string): SafetyClassification {
	const strictlyBlockedReason = firstMatch(STRICTLY_BLOCKED_COMMAND_PATTERNS, command);
	if (strictlyBlockedReason) return { decision: "deny", reason: strictlyBlockedReason };

	const sensitiveReferenceReason = findSensitiveCommandReference(command);
	if (sensitiveReferenceReason) return { decision: "deny", reason: sensitiveReferenceReason };

	const stateChangingReason = firstMatch(STATE_CHANGING_COMMAND_PATTERNS, command);
	if (stateChangingReason) return { decision: "review", reason: stateChangingReason };

	if (AUTO_ALLOWED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
		return { decision: "allow", reason: "recognized low-risk command" };
	}

	return { decision: "review", reason: "command is not on the low-risk allowlist" };
}

export function isSafeCommand(command: string): boolean {
	return classifyBashCommand(command).decision === "allow";
}

export function classifyBashCommand(command: string): SafetyClassification {
	const trimmed = command.trim();
	if (!trimmed) return { decision: "allow", reason: "empty command" };

	const strictlyBlockedReason = firstMatch(STRICTLY_BLOCKED_COMMAND_PATTERNS, trimmed);
	if (strictlyBlockedReason) return { decision: "deny", reason: strictlyBlockedReason };

	const sensitiveReferenceReason = findSensitiveCommandReference(trimmed);
	if (sensitiveReferenceReason) return { decision: "deny", reason: sensitiveReferenceReason };

	const composition = scanShellComposition(trimmed);
	if (composition.hasNonPipelineComposition) {
		return { decision: "review", reason: "shell composition can hide state-changing or secret-reading operations" };
	}

	const pipeline = composition.pipelineParts;
	if (pipeline) {
		const classifications = pipeline.map(classifySimpleBashCommand);
		const denied = classifications.find((classification) => classification.decision === "deny");
		if (denied) return denied;
		const reviewed = classifications.find((classification) => classification.decision === "review");
		return reviewed ?? { decision: "allow", reason: "recognized low-risk pipeline" };
	}

	return classifySimpleBashCommand(trimmed);
}

function getPathFromInput(input: Record<string, unknown>): string | undefined {
	const path = input.path;
	return typeof path === "string" ? path : undefined;
}

export function classifyPathAccess(path: string, _cwd?: string, access: PathAccess = "read"): SafetyClassification {
	const normalized = path.replace(/\\/g, "/");
	const protectedReason = firstMatch(PROTECTED_PATH_PATTERNS, normalized);
	if (protectedReason) return { decision: "deny", reason: protectedReason };

	const sensitiveReason = firstMatch(SENSITIVE_PATH_PATTERNS, normalized);
	if (sensitiveReason) {
		return access === "read"
			? { decision: "deny", reason: sensitiveReason }
			: { decision: "review", reason: sensitiveReason };
	}

	return { decision: "allow", reason: access === "read" ? "ordinary file read" : "ordinary file edit" };
}

export function classifyToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd?: string,
): SafetyClassification {
	if (["plan_question", "questionnaire", "question", "ask_question"].includes(toolName)) {
		return { decision: "allow", reason: "user-interaction tool" };
	}

	if (["read", "grep", "find", "ls"].includes(toolName)) {
		const path = getPathFromInput(input);
		return path ? classifyPathAccess(path, cwd, "read") : { decision: "allow", reason: "read-only tool" };
	}

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return classifyBashCommand(command);
	}

	if (toolName === "write" || toolName === "edit") {
		const path = getPathFromInput(input);
		if (!path) return { decision: "review", reason: `${toolName} target path is unclear` };
		return classifyPathAccess(path, cwd, "write");
	}

	return { decision: "review", reason: `unknown tool ${toolName} requires review` };
}
