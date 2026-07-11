import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	classifyExecutionBashCommand,
	classifyExecutionToolCall,
	classifyNormalBashCommand,
	classifyPathAccess,
	classifyResearchBashCommand,
	classifyResearchToolCall,
	isGitPushForceWithLeaseCommand,
	isResearchCommandAllowed,
} from "../modes/policies.ts";
import { handleModeToolCall, handleModeUserBash, isTrustedSubagentsTool } from "../modes/services.ts";
import { resolveCurrentMode, setCurrentMode } from "../modes/state.ts";
import { validatePublicHttpUrl } from "../shared/web-policies.ts";

describe("research gate", () => {
	const allowedCommands = [
		"rg TODO src",
		"rg \"rm\" src",
		"rg rm src",
		"rg \"touch\" src",
		"rg \"a > b\" src",
		"rg foo src 2>/dev/null",
		"rg foo src 2> /dev/null",
		"grep \"git commit\" file",
		"grep -R foo .",
		"nl -ba tmp.py",
		"git status --short",
		"git diff -- modes/policies.ts",
		"npm audit --json",
		"npm test",
		"npm run typecheck",
		"pytest",
		"pip --version",
		"python -m pip show requests",
		"curl -I https://example.com/api",
		"wget -O - https://example.com/file.txt",
		"find /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions -maxdepth 2 -type f | sort",
		"rg TODO src | wc -l",
		"rg \"registerCommand\\(\\\"name\\\"|registerCommand\\('name'|setStatus\\(\\\"my-name\\\"|setStatus\\('my-name'\" -n .",
		"npm run build",
		"go build ./...",
		"eslint .",
		"ruff check .",
		"ruff format --check .",
		"rg TOKEN .env",
		"git show HEAD:.env",
	];

	for (const command of allowedCommands) {
		it(`allows research command: ${command}`, () => {
			assert.equal(isResearchCommandAllowed(command), true);
			assert.equal(classifyResearchBashCommand(command).decision, "allow");
		});
	}

	const blockedCommands = [
		"find . -delete",
		"find . -name '*.tmp' -exec rm {} \\;",
		"curl -o file.txt https://example.com/file.txt",
		"curl --output file.txt https://example.com/file.txt",
		"curl -O https://example.com/file.txt",
		"curl -X POST https://example.com/api",
		"curl --request DELETE https://example.com/api/1",
		"curl -d '{\"name\":\"x\"}' https://example.com/api",
		"curl --json '{\"name\":\"x\"}' https://example.com/api",
		"wget -O file.txt https://example.com/file.txt",
		"npm audit fix",
		"pip install requests",
		"python -m pip install requests",
		"git commit -m test",
		"touch file.txt",
		"sed -i '' 's/a/b/' file.txt",
		"echo hello > file.txt",
		"rg foo src 2> errors.txt",
		"rg foo src 2>/dev/nullfile",
		"rg foo src 2>/dev/null > matches.txt",
		"nl -ba tmp.py > numbered.txt",
		"rg foo | tee matches.txt",
		"rg foo && rm -rf tmp",
		"rg foo; touch x",
		"ls & touch x",
		"rg foo & tee matches.txt",
		"ls\ntouch x",
		"git status\nrm temp.txt",
		"rg --pre 'python scripts/pre.py' foo .",
		"fd -x python scripts/do.py",
		"fd --exec-batch python scripts/do.py",
		"sort -o out.txt input.txt",
		"ls && node -e \"require('fs').writeFileSync('x','y')\"",
		"git status; rm -rf tmp",
		"echo $(cat .env)",
		"find . -name '*.ts' -exec python -c 'print(1)' \\;",
		"curl https://example.com/api",
		"eslint --fix .",
		"npx eslint --fix .",
		"ruff check --fix .",
		"ruff format .",
		"go fmt ./...",
		"make format",
	];

	for (const command of blockedCommands) {
		it(`blocks or reviews non-research command: ${command}`, () => {
			assert.equal(isResearchCommandAllowed(command), false);
			assert.notEqual(classifyResearchBashCommand(command).decision, "allow");
		});
	}

	it("denies destructive commands while allowing local dotfiles and key-like paths", () => {
		assert.deepEqual(classifyResearchBashCommand("sudo rm -rf /"), {
			decision: "deny",
			reason: "recursive force removal of a root/home path is destructive",
		});
		assert.notEqual(classifyResearchBashCommand("env").decision, "allow");
		assert.notEqual(classifyResearchBashCommand("printenv").decision, "allow");
		assert.equal(classifyPathAccess(".env", undefined, "read").decision, "allow");
		assert.equal(classifyPathAccess(".ssh/id_ed25519", undefined, "read").decision, "allow");
		assert.equal(classifyPathAccess("credentials.json", undefined, "write").decision, "allow");
	});

	it("allows ordinary reads outside the current workspace", () => {
		assert.equal(classifyPathAccess("/opt/homebrew/lib/node_modules/pkg/README.md", "/workspace", "read").decision, "allow");
	});

	it("classifies research tool calls", () => {
		assert.equal(classifyResearchToolCall("bash", { command: "find . -delete" }).decision, "deny");
		assert.equal(classifyResearchToolCall("bash", { command: "git status" }).decision, "allow");
		assert.equal(classifyResearchToolCall("read", { path: ".env" }).decision, "allow");
		assert.equal(classifyResearchToolCall("grep", { path: ".ssh/id_rsa", pattern: "x" }).decision, "allow");
		assert.equal(classifyResearchToolCall("web_research", { query: "zod docs" }).decision, "allow");
		assert.equal(classifyResearchToolCall("web_fetch", { url: "https://zod.dev" }).decision, "allow");
		assert.equal(classifyResearchToolCall("question_tool", { question: "Proceed?", options: [] }).decision, "allow");
		assert.equal(classifyResearchToolCall("edit", { path: "src/index.ts" }).decision, "deny");
	});

	it("blocks unsafe web fetch targets", () => {
		for (const url of ["file:///etc/passwd", "http://localhost:3000", "http://127.0.0.1", "http://192.168.1.1", "http://[::1]/"]) {
			assert.notEqual(classifyResearchToolCall("web_fetch", { url }).decision, "allow");
		}
	});

	it("uses the shared public URL policy", () => {
		assert.equal(validatePublicHttpUrl("https://example.com").hostname, "example.com");
		assert.throws(() => validatePublicHttpUrl("http://localhost:3000"), /local hostnames/);
		assert.throws(() => validatePublicHttpUrl("http://127.0.0.1"), /local\/private IPv4/);
	});
});

describe("execution gate", () => {
	it("allows low-risk execution commands", () => {
		assert.equal(classifyExecutionBashCommand("npm test").decision, "allow");
		assert.equal(classifyExecutionBashCommand("git status --short").decision, "allow");
	});

	it("allows ordinary workspace file edit/write classification", () => {
		assert.equal(classifyExecutionToolCall("edit", { path: "src/index.ts" }, "/workspace/project").decision, "allow");
		assert.equal(classifyExecutionToolCall("write", { path: "/workspace/project/src/new.ts" }, "/workspace/project").decision, "allow");
	});

	it("reviews file edit/write targets outside the workspace", () => {
		assert.equal(classifyExecutionToolCall("edit", { path: "../outside.ts" }, "/workspace/project").decision, "review");
		assert.equal(classifyExecutionToolCall("write", { path: "/tmp/outside.ts" }, "/workspace/project").decision, "review");
	});

	it("classifies web research tools", () => {
		assert.equal(classifyExecutionToolCall("web_research", { query: "zod docs" }).decision, "allow");
		assert.equal(classifyExecutionToolCall("web_fetch", { url: "https://zod.dev" }).decision, "allow");
		assert.equal(classifyExecutionToolCall("question_tool", { question: "Proceed?", options: [] }).decision, "allow");
		assert.notEqual(classifyExecutionToolCall("web_fetch", { url: "http://localhost:3000" }).decision, "allow");
	});

	it("denies strictly destructive commands", () => {
		assert.equal(classifyExecutionBashCommand("sudo rm -rf /").decision, "deny");
	});

	it("keeps plain force-push denied while reviewing force-with-lease in execution mode", () => {
		assert.equal(classifyExecutionBashCommand("git push --force origin HEAD").decision, "deny");
		assert.equal(classifyExecutionBashCommand("git push -f origin HEAD").decision, "deny");
		assert.equal(classifyExecutionBashCommand("git push -fu origin HEAD").decision, "deny");
		assert.equal(classifyExecutionBashCommand("git push --force-with-lease -u origin HEAD").decision, "review");
		assert.equal(classifyNormalBashCommand("git push --force-with-lease -u origin HEAD").decision, "deny");
		assert.equal(isGitPushForceWithLeaseCommand("git push --force-with-lease -u origin HEAD"), true);
		assert.equal(isGitPushForceWithLeaseCommand("git push --force-with-lease -u origin HEAD && rm temp.txt"), false);
		assert.equal(classifyExecutionBashCommand("python -c 'import django'").decision, "review");
	});

	it("reviews destructive or ambiguous execution commands", () => {
		assert.equal(classifyExecutionBashCommand("git commit -m test").decision, "review");
		assert.equal(classifyExecutionBashCommand("rm temp.txt").decision, "review");
		assert.equal(classifyExecutionBashCommand("python script.py").decision, "review");
		assert.equal(classifyExecutionBashCommand("rg --pre 'python scripts/pre.py' foo .").decision, "review");
		assert.equal(classifyExecutionBashCommand("fd -x python scripts/do.py").decision, "review");
		assert.equal(classifyExecutionBashCommand("sort -o out.txt input.txt").decision, "review");
		assert.equal(classifyExecutionBashCommand("ls & touch x").decision, "review");
		assert.equal(classifyExecutionBashCommand("ls\ntouch x").decision, "review");
	});
});

describe("mode tool-call router", () => {
	const ctx = { cwd: "/workspace/project", hasUI: false } as any;

	it("recognizes only SDK or user-scoped subagents as trusted", () => {
		assert.equal(isTrustedSubagentsTool({ name: "subagents", sourceInfo: { source: "sdk", scope: "temporary" } }), true);
		assert.equal(isTrustedSubagentsTool({ name: "subagents", sourceInfo: { source: "extension", scope: "user" } }), true);
		assert.equal(isTrustedSubagentsTool({ name: "subagents", sourceInfo: { source: "extension", scope: "project" } }), false);
		assert.equal(isTrustedSubagentsTool({ name: "other", sourceInfo: { source: "sdk", scope: "temporary" } }), false);
	});

	it("bypasses autoreview only for trusted subagents in research-like modes", async () => {
		const trustedReadOnlyTools = new Set(["subagents"]);
		for (const mode of ["research", "plan", "brainstorming"] as const) {
			const trusted = await handleModeToolCall(
				mode,
				{ type: "tool_call", toolCallId: mode, toolName: "subagents", input: { tasks: [{ task: "Inspect" }] } } as any,
				ctx,
				{ trustedReadOnlyTools },
			);
			assert.equal(trusted, undefined);
		}

		const untrusted = await handleModeToolCall(
			"research",
			{ type: "tool_call", toolCallId: "untrusted", toolName: "subagents", input: { tasks: [{ task: "Inspect" }] } } as any,
			ctx,
		);
		assert.equal(untrusted?.block, true);
		assert.match(untrusted?.reason ?? "", /autoreviewer blocked subagents/i);
	});

	it("does not apply the trusted research bypass in normal, inline, or auto mode", async () => {
		const trustedReadOnlyTools = new Set(["subagents"]);
		for (const mode of ["normal", "inline", "auto"] as const) {
			const result = await handleModeToolCall(
				mode,
				{ type: "tool_call", toolCallId: mode, toolName: "subagents", input: { tasks: [{ task: "Inspect" }] } } as any,
				ctx,
				{ trustedReadOnlyTools },
			);
			assert.equal(result?.block, true);
		}
	});

	it("continues to review ordinary unknown tools", async () => {
		const result = await handleModeToolCall(
			"research",
			{ type: "tool_call", toolCallId: "unknown", toolName: "unknown_tool", input: {} } as any,
			ctx,
			{ trustedReadOnlyTools: new Set(["subagents"]) },
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /autoreviewer blocked unknown_tool/i);
	});

	it("requires inline approval for write instead of hard-blocking it", async () => {
		const result = await handleModeToolCall(
			"inline",
			{ type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "src/index.ts", content: "" } } as any,
			ctx,
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /inline mode requires user approval before write/);
		assert.doesNotMatch(result?.reason ?? "", /does not allow creating or replacing files/);
		assert.doesNotMatch(result?.reason ?? "", /not available/);
	});

	it("requires normal and inline approval for edit", async () => {
		for (const mode of ["normal", "inline"] as const) {
			const result = await handleModeToolCall(
				mode,
				{ type: "tool_call", toolCallId: mode, toolName: "edit", input: { path: "src/index.ts", oldText: "a", newText: "b" } } as any,
				ctx,
			);

			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", new RegExp(`${mode} mode requires user approval before edit`));
		}
	});

	it("routes normal and inline ambiguous bash through the mode-aware autoreviewer", async () => {
		for (const mode of ["normal", "inline"] as const) {
			const result = await handleModeToolCall(
				mode,
				{ type: "tool_call", toolCallId: mode, toolName: "bash", input: { command: "python -c 'import django'" } } as any,
				ctx,
			);

			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", /autoreviewer blocked shell command/i);
			assert.doesNotMatch(result?.reason ?? "", /requires explicit user approval/);
		}
	});

	it("routes normal and inline ambiguous user bash through the mode-aware autoreviewer", async () => {
		for (const mode of ["normal", "inline"] as const) {
			const result = await handleModeUserBash(
				mode,
				{ type: "user_bash", command: "python -c 'import django'" } as any,
				ctx,
			);

			assert.equal(result?.result?.exitCode, 1);
			assert.match(result?.result?.output ?? "", /autoreviewer blocked shell command/i);
			assert.doesNotMatch(result?.result?.output ?? "", /requires explicit user approval/);
		}
	});

	it("blocks normal and inline state-changing bash directly", async () => {
		for (const mode of ["normal", "inline"] as const) {
			const result = await handleModeToolCall(
				mode,
				{ type: "tool_call", toolCallId: mode, toolName: "bash", input: { command: "touch file.txt" } } as any,
				ctx,
			);

			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", new RegExp(`${mode} mode blocked shell command`));
			assert.doesNotMatch(result?.reason ?? "", /autoreviewer|approval/i);
		}
	});

	it("routes research-like modes through the mode-aware autoreviewer after triage", async () => {
		for (const mode of ["research", "plan", "brainstorming"] as const) {
			const result = await handleModeToolCall(
				mode,
				{ type: "tool_call", toolCallId: mode, toolName: "edit", input: { path: "src/index.ts", oldText: "a", newText: "b" } } as any,
				ctx,
			);

			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", new RegExp(`${mode} mode blocked edit`));
		}
	});

	it("routes auto mode through the execution policy", async () => {
		const result = await handleModeToolCall(
			"auto",
			{ type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "src/index.ts", oldText: "a", newText: "b" } } as any,
			ctx,
		);

		assert.equal(result, undefined);
	});
});

describe("mode state resolution", () => {
	it("prefers active system-prompt markers over singleton state", () => {
		setCurrentMode("normal");
		assert.equal(resolveCurrentMode({ getSystemPrompt: () => "[RESEARCH MODE ACTIVE]" }), "research");
		assert.equal(resolveCurrentMode({ getSystemPrompt: () => "[INLINE MODE ACTIVE]" }), "inline");
	});

	it("falls back to persisted session mode before singleton state", () => {
		setCurrentMode("normal");
		assert.equal(
			resolveCurrentMode({
				sessionManager: {
					getBranch: () => [{ type: "custom", customType: "modes", data: { mode: "brainstorming" } }],
				},
			}),
			"brainstorming",
		);
		assert.equal(
			resolveCurrentMode({
				sessionManager: {
					getBranch: () => [{ type: "custom", customType: "modes", data: { mode: "inline" } }],
				},
			}),
			"inline",
		);
	});
});

describe("normal mode command policy", () => {
	it("allows normal allowlist and research-gate commands", () => {
		assert.equal(classifyNormalBashCommand("git status --short").decision, "allow");
		assert.equal(classifyNormalBashCommand("npm test").decision, "allow");
	});

	it("denies changing commands and avoids quoted/search-text false positives", () => {
		assert.equal(classifyNormalBashCommand("git commit -m test").decision, "deny");
		assert.equal(classifyNormalBashCommand("rg TOKEN .env").decision, "allow");
		assert.equal(classifyNormalBashCommand("rg sudo .").decision, "allow");
		assert.equal(classifyNormalBashCommand("grep \"git push\" README.md").decision, "allow");
		assert.equal(classifyNormalBashCommand("echo \"npm publish\"").decision, "allow");
	});

	it("does not allow unsafe commands through safe-looking prefixes", () => {
		assert.notEqual(classifyNormalBashCommand("find . -delete").decision, "allow");
		assert.notEqual(classifyNormalBashCommand("ls && touch owned.txt").decision, "allow");
		assert.notEqual(classifyNormalBashCommand("git status; rm temp.txt").decision, "allow");
		assert.notEqual(classifyNormalBashCommand("rg foo | tee matches.txt").decision, "allow");
		assert.notEqual(classifyNormalBashCommand("ls & touch owned.txt").decision, "allow");
		assert.notEqual(classifyNormalBashCommand("ls\ntouch owned.txt").decision, "allow");
	});

	it("reviews ambiguous research commands and denies state-changing commands", () => {
		assert.equal(classifyNormalBashCommand("python script.py").decision, "review");
		assert.equal(classifyNormalBashCommand("python -c 'import django'").decision, "review");
		assert.equal(classifyNormalBashCommand("touch file.txt").decision, "deny");
		assert.equal(classifyNormalBashCommand("pip install requests").decision, "deny");
		assert.equal(classifyNormalBashCommand("git commit -m test").decision, "deny");
	});
});
