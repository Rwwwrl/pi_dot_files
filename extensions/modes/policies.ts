import { resolve } from "node:path";
import { evaluatePublicHttpUrl } from "../shared/web-policies.ts";

export type SafetyDecision = "allow" | "deny" | "review";
export type PathAccess = "read" | "write";

export interface SafetyClassification {
	decision: SafetyDecision;
	reason: string;
}

export interface BashClassificationPolicy {
	stateChangingDecision: SafetyDecision;
	lowRiskReason: string;
	unlistedReason: string;
}

export interface ToolClassificationPolicy {
	writeDecision: "deny" | "classify-path";
	writeDeniedReason: (toolName: string) => string;
	unknownReason: (toolName: string) => string;
}

export const READ_ONLY_COMMAND_PATTERNS: RegExp[] = [
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
	/^\s*pnpm\s+(list|info|why|audit)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python\s+--version\b/i,
	/^\s*python3\s+--version\b/i,
	/^\s*pip\s+(?:--version|-V|list|show|freeze|check)\b/i,
	/^\s*python\s+-m\s+pip\s+(?:--version|-V|list|show|freeze|check)\b/i,
	/^\s*python3\s+-m\s+pip\s+(?:--version|-V|list|show|freeze|check)\b/i,
	/^\s*curl\s+(?:-I|--head)\b/i,
	/^\s*wget\s+-O\s*-(?:\s|$)/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n\b/i,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export const RESEARCH_COMMAND_PATTERNS: RegExp[] = [
	...READ_ONLY_COMMAND_PATTERNS,
	/^\s*(?:npm|yarn|pnpm)\s+(?:test|run\s+(?:test|build|lint|typecheck|check|format:check|validate)\b)/i,
	/^\s*(?:npx\s+)?(?:tsc|prettier\s+--check|vitest|jest|mocha|ava|cargo\s+(?:test|check|build|fmt\s+--check|clippy)|go\s+(?:test|build|vet)|pytest|mypy)\b/i,
	/^\s*(?:npx\s+)?eslint\b(?!.*(?:^|\s)--fix(?:\s|=|$))/i,
	/^\s*ruff\s+check\b(?!.*(?:^|\s)--fix(?:\s|=|$))/i,
	/^\s*ruff\s+format\b(?=.*(?:^|\s)--check(?:\s|=|$))/i,
	/^\s*make\s+(?:test|check|build|lint)\b/i,
	/^\s*git\s+(?:status|log|diff|show|branch|remote|config\s+--get|ls-files|grep|blame)\b/i,
];

export function matchesAny(patterns: RegExp[], value: string): boolean {
	return patterns.some((pattern) => pattern.test(value));
}

export interface ShellToken {
	text: string;
	quoted: boolean;
}

function tokenizeShellPart(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let text = "";
	let quoted = false;
	let quote: "single" | "double" | undefined;
	let escaped = false;

	function pushToken(): void {
		if (!text && !quoted) return;
		tokens.push({ text, quoted });
		text = "";
		quoted = false;
	}

	for (let index = 0; index < command.length; index++) {
		const char = command[index];

		if (escaped) {
			text += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote === "single") {
			if (char === "'") {
				quote = undefined;
			} else {
				text += char;
			}
			quoted = true;
			continue;
		}

		if (quote === "double") {
			if (char === '"') {
				quote = undefined;
			} else {
				text += char;
			}
			quoted = true;
			continue;
		}

		if (/\s/.test(char)) {
			pushToken();
			continue;
		}

		if (char === "'") {
			quote = "single";
			quoted = true;
			continue;
		}

		if (char === '"') {
			quote = "double";
			quoted = true;
			continue;
		}

		text += char;
	}

	pushToken();
	return tokens;
}

function commandName(tokens: ShellToken[]): string {
	return (tokens[0]?.text ?? "").toLowerCase();
}

function hasToken(tokens: ShellToken[], predicate: (token: string, index: number) => boolean): boolean {
	return tokens.some((token, index) => predicate(token.text.toLowerCase(), index));
}

function hasFlag(tokens: ShellToken[], flag: string): boolean {
	return hasToken(tokens, (token) => token === flag || token.startsWith(`${flag}=`));
}

function commandAfterOptionalEnv(tokens: ShellToken[]): ShellToken[] {
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index].text)) index++;
	return tokens.slice(index);
}

function gitSubcommand(tokens: ShellToken[]): string | undefined {
	return tokens.find((token, index) => index > 0 && !token.text.startsWith("-"))?.text.toLowerCase();
}

function hasGitForcePushFlag(tokens: ShellToken[]): boolean {
	return hasToken(tokens, (token) => token === "--force" || hasShortFlags(token, "f"));
}

function hasGitForceWithLeaseFlag(tokens: ShellToken[]): boolean {
	return hasToken(tokens, (token) => token === "--force-with-lease" || token.startsWith("--force-with-lease="));
}

export function isGitPushForceWithLeaseCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;

	const composition = scanShellComposition(trimmed);
	if (composition.hasNonPipelineComposition || composition.pipelineParts) return false;

	const tokens = commandAfterOptionalEnv(tokenizeShellPart(trimmed));
	return commandName(tokens) === "git" && gitSubcommand(tokens) === "push" && hasGitForceWithLeaseFlag(tokens) && !hasGitForcePushFlag(tokens);
}

function hasShortFlags(token: string, flags: string): boolean {
	if (!token.startsWith("-") || token.startsWith("--")) return false;
	return [...flags].every((flag) => token.slice(1).includes(flag));
}

function hasRootOrHomeTarget(tokens: ShellToken[]): boolean {
	return tokens.some((token, index) => {
		if (index === 0 || token.text.startsWith("-")) return false;
		return ["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*"].includes(token.text);
	});
}

function hasUnquotedOutputRedirection(command: string): boolean {
	let quote: "single" | "double" | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote === "single") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (char === '"') quote = undefined;
			continue;
		}
		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === '"') {
			quote = "double";
			continue;
		}
		if (char === ">") return true;
	}

	return false;
}

function classifyCurlMutation(tokens: ShellToken[]): string | undefined {
	const methodMutates = new Set(["POST", "PUT", "PATCH", "DELETE"]);
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index].text;
		const lower = token.toLowerCase();
		const next = tokens[index + 1]?.text;

		if (["-o", "--output", "--remote-name", "-t", "--upload-file"].includes(lower)) {
			return "curl output/upload options write files or remote state";
		}
		if (lower.startsWith("--output=") || lower.startsWith("--upload-file=")) {
			return "curl output/upload options write files or remote state";
		}
		if (token === "-X" || lower === "--request") {
			if (next && methodMutates.has(next.toUpperCase())) return "curl request options can mutate remote state";
		}
		if (token.startsWith("-X") && token.length > 2 && methodMutates.has(token.slice(2).toUpperCase())) {
			return "curl request options can mutate remote state";
		}
		if (lower.startsWith("--request=") && methodMutates.has(token.slice("--request=".length).toUpperCase())) {
			return "curl request options can mutate remote state";
		}
		if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "--json"].includes(lower)) {
			return "curl request options can mutate remote state";
		}
		if (/^-d.+/i.test(token) || /^-F.+/.test(token) || /^--(?:data|data-raw|data-binary|data-urlencode|form|json)=/i.test(token)) {
			return "curl request options can mutate remote state";
		}
	}
	return undefined;
}

function classifyWgetMutation(tokens: ShellToken[]): string | undefined {
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index].text;
		const lower = token.toLowerCase();
		const next = tokens[index + 1]?.text;
		if (token === "-o") continue; // wget -o writes logs; keep it off the research allowlist but not a file download.
		if (token === "-O") {
			if (next && next !== "-") return "wget output options write files";
		}
		if (lower.startsWith("--output-document=")) {
			if (token.slice("--output-document=".length) !== "-") return "wget output options write files";
		}
		if (lower === "--output-document") {
			if (next && next !== "-") return "wget output options write files";
		}
	}
	return undefined;
}

export function findStrictlyBlockedCommandReason(command: string): string | undefined {
	if (/:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/.test(command)) return "fork bombs are not allowed";

	const composition = scanShellComposition(command);
	const pipeline = composition.pipelineParts;
	if (pipeline) {
		const parts = pipeline.map((part) => commandAfterOptionalEnv(tokenizeShellPart(part)));
		const firstCommand = commandName(parts[0] ?? []);
		const secondCommand = commandName(parts[1] ?? []);
		if (["curl", "wget"].includes(firstCommand) && ["sh", "bash", "zsh", "fish"].includes(secondCommand)) {
			return "piping downloaded code into a shell is not allowed";
		}
	}

	const tokens = commandAfterOptionalEnv(tokenizeShellPart(command));
	const name = commandName(tokens);
	if (!name) return undefined;

	const rmTokens = name === "sudo" && tokens[1]?.text.toLowerCase() === "rm" ? tokens.slice(1) : tokens;
	if (commandName(rmTokens) === "rm" && rmTokens.some((token) => hasShortFlags(token.text, "rf")) && hasRootOrHomeTarget(rmTokens)) {
		return "recursive force removal of a root/home path is destructive";
	}

	if (name === "git") {
		const subcommand = gitSubcommand(tokens);
		if (subcommand === "reset" && hasFlag(tokens, "--hard")) return "git reset --hard can irreversibly discard work";
		if (subcommand === "clean" && tokens.some((token) => token.text.startsWith("-") && /[fdx]/i.test(token.text))) {
			return "git clean with force/delete flags can remove untracked work";
		}
		if (subcommand === "push" && hasGitForcePushFlag(tokens)) {
			return "force pushing rewrites remote history";
		}
	}

	if (["sudo", "su"].includes(name)) return "privilege escalation is not allowed";
	if (["mkfs", "fdisk", "parted", "mount", "umount"].includes(name)) return "disk/partition operations are not allowed";
	if (name === "diskutil" && hasToken(tokens, (token) => ["erase", "partition"].includes(token))) {
		return "disk/partition operations are not allowed";
	}
	if (name === "dd" && hasToken(tokens, (token) => token.startsWith("of=/dev/"))) return "writing raw data to devices is destructive";
	if (["shutdown", "reboot", "halt", "poweroff"].includes(name)) return "system power commands are not allowed";
	if (["npm", "yarn", "pnpm"].includes(name) && hasToken(tokens, (token) => token === "publish")) return "publishing packages is not allowed";

	return undefined;
}

export function findStateChangingCommandReason(command: string): string | undefined {
	if (hasUnquotedOutputRedirection(command)) return "output redirection writes files";

	const tokens = commandAfterOptionalEnv(tokenizeShellPart(command));
	const name = commandName(tokens);
	if (!name) return undefined;

	const runnableTokens = name === "npx" ? tokens.slice(1) : tokens;
	const runnableName = commandName(runnableTokens);
	if (runnableName === "eslint" && hasToken(runnableTokens, (token) => token === "--fix" || token.startsWith("--fix="))) return "eslint --fix edits files";
	if (runnableName === "ruff") {
		const subcommand = runnableTokens[1]?.text.toLowerCase();
		if (subcommand === "check" && hasToken(runnableTokens, (token) => token === "--fix" || token.startsWith("--fix="))) return "ruff check --fix edits files";
		if (subcommand === "format" && !hasFlag(runnableTokens, "--check")) return "ruff format edits files unless --check is used";
	}
	if (runnableName === "go" && runnableTokens[1]?.text.toLowerCase() === "fmt") return "go fmt edits files";
	if (runnableName === "cargo" && runnableTokens[1]?.text.toLowerCase() === "fmt" && !hasFlag(runnableTokens, "--check")) return "cargo fmt edits files unless --check is used";
	if (name === "make" && hasToken(tokens, (token) => token === "format")) return "make format usually edits files";

	if (["rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln", "tee", "truncate", "dd", "shred"].includes(name)) {
		const reasons: Record<string, string> = {
			rm: "rm changes filesystem state",
			rmdir: "rmdir changes filesystem state",
			mv: "mv changes filesystem state",
			cp: "cp changes filesystem state",
			mkdir: "mkdir changes filesystem state",
			touch: "touch changes filesystem state",
			chmod: "chmod changes filesystem permissions",
			chown: "chown changes filesystem ownership",
			chgrp: "chgrp changes filesystem ownership",
			ln: "ln changes filesystem state",
			tee: "tee usually writes files",
			truncate: "truncate changes filesystem state",
			dd: "dd can write files or devices",
			shred: "shred destroys file contents",
		};
		return reasons[name];
	}

	if (name === "find") {
		if (hasToken(tokens, (token) => token === "-delete")) return "find -delete removes files";
		if (hasToken(tokens, (token) => token === "-exec" || token === "-execdir")) return "find -exec can run arbitrary commands";
	}

	if (name === "sed" && hasToken(tokens, (token) => token === "-i" || /^-i.+/.test(token))) return "sed -i edits files in place";
	if (name === "awk" && hasToken(tokens, (token, index) => token === "-i" && tokens[index + 1]?.text.toLowerCase() === "inplace")) {
		return "awk inplace mode edits files";
	}
	if (name === "perl" && hasToken(tokens, (token) => /^-[A-Za-z]*p[A-Za-z]*i[A-Za-z]*$/.test(token) || /^-[A-Za-z]*i[A-Za-z]*p[A-Za-z]*$/.test(token))) {
		return "perl -pi edits files in place";
	}

	if (name === "xargs" && hasToken(tokens, (token, index) => index > 0 && ["rm", "rmdir", "mv", "cp", "chmod", "chown", "chgrp", "shred", "truncate", "tee"].includes(token))) {
		return "xargs can run state-changing commands";
	}

	if (name === "curl") return classifyCurlMutation(tokens);
	if (name === "wget") return classifyWgetMutation(tokens);

	if (name === "rg" && hasToken(tokens, (token) => token === "--pre" || token.startsWith("--pre="))) {
		return "rg --pre can execute arbitrary commands";
	}
	if (name === "fd" && hasToken(tokens, (token) => ["-x", "-X", "--exec", "--exec-batch"].includes(token) || token.startsWith("--exec=") || token.startsWith("--exec-batch="))) {
		return "fd exec options can run arbitrary commands";
	}
	if (name === "sort" && hasToken(tokens, (token) => token === "-o" || token.startsWith("--output="))) return "sort output options write files";

	if (name === "npm" && hasToken(tokens, (token, index) => {
		const previous = tokens[index - 1]?.text.toLowerCase();
		return token === "install" || token === "uninstall" || token === "update" || token === "ci" || token === "link" || token === "publish" || (token === "fix" && previous === "audit");
	})) return "npm command changes dependencies or publishes packages";
	if (name === "yarn" && hasToken(tokens, (token) => ["add", "remove", "install", "publish"].includes(token))) return "yarn command changes dependencies or publishes packages";
	if (name === "pnpm" && hasToken(tokens, (token) => ["add", "remove", "install", "publish"].includes(token))) return "pnpm command changes dependencies or publishes packages";
	if (name === "pip" && hasToken(tokens, (token) => ["install", "uninstall"].includes(token))) return "pip command changes Python packages";
	if (["python", "python3"].includes(name) && tokens[1]?.text === "-m" && tokens[2]?.text.toLowerCase() === "pip" && hasToken(tokens.slice(3), (token) => ["install", "uninstall"].includes(token))) {
		return "pip command changes Python packages";
	}
	if (["apt", "apt-get"].includes(name) && hasToken(tokens, (token) => ["install", "remove", "purge", "update", "upgrade"].includes(token))) return "apt command changes system packages";
	if (name === "brew" && hasToken(tokens, (token) => ["install", "uninstall", "upgrade"].includes(token))) return "brew command changes packages";

	if (name === "git") {
		const subcommand = gitSubcommand(tokens);
		if (subcommand === "push" && hasGitForceWithLeaseFlag(tokens)) {
			return "git push --force-with-lease rewrites remote history and requires explicit user confirmation";
		}
		if (subcommand && ["add", "commit", "push", "pull", "merge", "rebase", "reset", "checkout", "stash", "cherry-pick", "revert", "tag", "init", "clone"].includes(subcommand)) {
			return "git command changes repository state";
		}
		if (subcommand === "branch" && hasToken(tokens, (token) => token === "-d" || token === "-D".toLowerCase())) return "git command changes repository state";
	}

	if (["sudo", "su"].includes(name)) return "sudo escalates privileges";
	if (["kill", "pkill", "killall"].includes(name)) return `${name} changes process state`;
	if (["reboot", "shutdown"].includes(name)) return `${name} changes system state`;
	if (name === "systemctl" && hasToken(tokens, (token) => ["start", "stop", "restart", "enable", "disable"].includes(token))) return "systemctl command changes service state";
	if (name === "service" && hasToken(tokens, (token) => ["start", "stop", "restart"].includes(token))) return "service command changes service state";
	if (["vi", "vim", "nano", "emacs", "code", "subl"].includes(name)) return "interactive editors can modify files";

	return undefined;
}

export function scanShellComposition(command: string): { hasNonPipelineComposition: boolean; pipelineParts?: string[] } {
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

		if (
			char === ";" ||
			char === "\n" ||
			char === "\r" ||
			char === "`" ||
			(char === "$" && next === "(") ||
			(["<", ">"].includes(char) && next === "(")
		) {
			return { hasNonPipelineComposition: true };
		}

		if (char === "&" || (char === "|" && next === "|")) {
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

function normalizePolicyPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function isWithinDirectory(path: string, directory: string): boolean {
	const normalizedPath = normalizePolicyPath(path);
	const normalizedDirectory = normalizePolicyPath(directory);
	if (normalizedPath === normalizedDirectory) return true;
	const directoryPrefix = normalizedDirectory.endsWith("/") ? normalizedDirectory : `${normalizedDirectory}/`;
	return normalizedPath.startsWith(directoryPrefix);
}

function classifyPublicHttpUrl(rawUrl: unknown): SafetyClassification {
	const evaluation = evaluatePublicHttpUrl(rawUrl);
	if (evaluation.allow) return { decision: "allow", reason: "public HTTP(S) web fetch" };
	if (typeof rawUrl !== "string" || !rawUrl.trim()) return { decision: "review", reason: "web_fetch URL is unclear" };
	return { decision: "deny", reason: `web_fetch ${evaluation.reason}` };
}

export function classifyPathAccess(path: string, cwd?: string, access: PathAccess = "read"): SafetyClassification {
	if (access === "write" && cwd) {
		const workspace = resolve(cwd);
		const absolutePath = resolve(cwd, path);
		if (!isWithinDirectory(absolutePath, workspace)) {
			return { decision: "review", reason: "write target is outside the current workspace" };
		}
	}

	return { decision: "allow", reason: access === "read" ? "ordinary file read" : "ordinary file edit" };
}

export function getPathFromInput(input: Record<string, unknown>): string | undefined {
	const path = input.path;
	return typeof path === "string" ? path : undefined;
}

export function classifyPipeline(
	command: string,
	classifySimpleCommand: (part: string) => SafetyClassification,
): SafetyClassification | undefined {
	const composition = scanShellComposition(command);
	if (composition.hasNonPipelineComposition) {
		return { decision: "review", reason: "shell composition can hide state-changing or hidden operations" };
	}

	const pipeline = composition.pipelineParts;
	if (!pipeline) return undefined;

	const classifications = pipeline.map(classifySimpleCommand);
	const denied = classifications.find((classification) => classification.decision === "deny");
	if (denied) return denied;
	const reviewed = classifications.find((classification) => classification.decision === "review");
	return reviewed ?? { decision: "allow", reason: "recognized low-risk pipeline" };
}

function classifySimpleBashCommandWithPolicy(command: string, policy: BashClassificationPolicy): SafetyClassification {
	const strictlyBlockedReason = findStrictlyBlockedCommandReason(command);
	if (strictlyBlockedReason) return { decision: "deny", reason: strictlyBlockedReason };

	const stateChangingReason = findStateChangingCommandReason(command);
	if (stateChangingReason) return { decision: policy.stateChangingDecision, reason: stateChangingReason };

	if (matchesAny(RESEARCH_COMMAND_PATTERNS, command)) {
		return { decision: "allow", reason: policy.lowRiskReason };
	}

	return { decision: "review", reason: policy.unlistedReason };
}

export function classifyBashCommandWithPolicy(command: string, policy: BashClassificationPolicy): SafetyClassification {
	const trimmed = command.trim();
	if (!trimmed) return { decision: "allow", reason: "empty command" };

	const strictlyBlockedReason = findStrictlyBlockedCommandReason(trimmed);
	if (strictlyBlockedReason) return { decision: "deny", reason: strictlyBlockedReason };

	const pipelineClassification = classifyPipeline(trimmed, (part) => classifySimpleBashCommandWithPolicy(part, policy));
	if (pipelineClassification) return pipelineClassification;

	return classifySimpleBashCommandWithPolicy(trimmed, policy);
}

export function classifyToolCallWithPolicy(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string | undefined,
	bashPolicy: BashClassificationPolicy,
	toolPolicy: ToolClassificationPolicy,
): SafetyClassification {
	if (["plan_question", "questionnaire", "question", "ask_question"].includes(toolName)) {
		return { decision: "allow", reason: "user-interaction tool" };
	}

	if (["read", "grep", "find", "ls"].includes(toolName)) {
		const path = getPathFromInput(input);
		return path ? classifyPathAccess(path, cwd, "read") : { decision: "allow", reason: "read-only tool" };
	}

	if (toolName === "web_research") {
		const query = input.query;
		return typeof query === "string" && query.trim()
			? { decision: "allow", reason: "read-only web research" }
			: { decision: "review", reason: "web_research query is unclear" };
	}

	if (toolName === "web_fetch") {
		return classifyPublicHttpUrl(input.url);
	}

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return classifyBashCommandWithPolicy(command, bashPolicy);
	}

	if (toolName === "write" || toolName === "edit") {
		if (toolPolicy.writeDecision === "deny") return { decision: "deny", reason: toolPolicy.writeDeniedReason(toolName) };
		const path = getPathFromInput(input);
		if (!path) return { decision: "review", reason: `${toolName} target path is unclear` };
		return classifyPathAccess(path, cwd, "write");
	}

	return { decision: "review", reason: toolPolicy.unknownReason(toolName) };
}

const RESEARCH_BASH_POLICY: BashClassificationPolicy = {
	stateChangingDecision: "deny",
	lowRiskReason: "recognized research command",
	unlistedReason: "command is not on the research allowlist",
};

const RESEARCH_TOOL_POLICY: ToolClassificationPolicy = {
	writeDecision: "deny",
	writeDeniedReason: (toolName) => `${toolName} intentionally modifies files and is not allowed by the research gate`,
	unknownReason: (toolName) => `unknown tool ${toolName} requires research-gate review`,
};

const EXECUTION_BASH_POLICY: BashClassificationPolicy = {
	stateChangingDecision: "review",
	lowRiskReason: "recognized low-risk execution command",
	unlistedReason: "command is not on the low-risk execution allowlist",
};

const EXECUTION_TOOL_POLICY: ToolClassificationPolicy = {
	writeDecision: "classify-path",
	writeDeniedReason: (toolName) => `${toolName} intentionally modifies files`,
	unknownReason: (toolName) => `unknown tool ${toolName} requires execution-gate review`,
};

export function classifyResearchBashCommand(command: string): SafetyClassification {
	return classifyBashCommandWithPolicy(command, RESEARCH_BASH_POLICY);
}

export function isResearchCommandAllowed(command: string): boolean {
	return classifyResearchBashCommand(command).decision === "allow";
}

export function classifyResearchToolCall(toolName: string, input: Record<string, unknown>, cwd?: string): SafetyClassification {
	return classifyToolCallWithPolicy(toolName, input, cwd, RESEARCH_BASH_POLICY, RESEARCH_TOOL_POLICY);
}

export function classifyExecutionBashCommand(command: string): SafetyClassification {
	return classifyBashCommandWithPolicy(command, EXECUTION_BASH_POLICY);
}

export function isExecutionCommandAllowed(command: string): boolean {
	return classifyExecutionBashCommand(command).decision === "allow";
}

export function classifyExecutionToolCall(toolName: string, input: Record<string, unknown>, cwd?: string): SafetyClassification {
	return classifyToolCallWithPolicy(toolName, input, cwd, EXECUTION_BASH_POLICY, EXECUTION_TOOL_POLICY);
}

export function classifyNormalBashCommand(command: string): SafetyClassification {
	const trimmed = command.trim();
	if (!trimmed) return { decision: "allow", reason: "empty command" };

	const strictlyBlockedReason = findStrictlyBlockedCommandReason(trimmed);
	if (strictlyBlockedReason) return { decision: "deny", reason: strictlyBlockedReason };

	const researchClassification = classifyResearchBashCommand(trimmed);
	if (researchClassification.decision === "allow") return researchClassification;

	return { decision: "review", reason: researchClassification.reason };
}
