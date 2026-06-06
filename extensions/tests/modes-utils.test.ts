import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyBashCommand, classifyPathAccess, classifyToolCall, isSafeCommand } from "../modes/auto/safety.ts";

describe("bash safety", () => {
	const safeCommands = [
		"rg TODO src",
		"grep -R foo .",
		"git status --short",
		"git diff -- modes/auto/safety.ts",
		"npm audit --json",
		"curl -I https://example.com/api",
		"wget -O - https://example.com/file.txt",
		"find /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions -maxdepth 2 -type f | sort",
		"rg TODO src | wc -l",
		"rg \"registerCommand\\(\\\"name\\\"|registerCommand\\('name'|setStatus\\(\\\"my-name\\\"|setStatus\\('my-name'\" -n .",
	];

	for (const command of safeCommands) {
		it(`allows read-only command: ${command}`, () => {
			assert.equal(isSafeCommand(command), true);
			assert.equal(classifyBashCommand(command).decision, "allow");
		});
	}

	const readOnlyBlockedCommands = [
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
		"sed -i '' 's/a/b/' file.txt",
		"echo hello > file.txt",
		"rg foo | tee matches.txt",
		"ls && node -e \"require('fs').writeFileSync('x','y')\"",
		"git status; rm -rf tmp",
		"echo $(cat .env)",
		"find . -name '*.ts' -exec python -c 'print(1)' \\;",
		"curl https://example.com/api",
	];

	for (const command of readOnlyBlockedCommands) {
		it(`blocks unsafe read-only command: ${command}`, () => {
			assert.equal(isSafeCommand(command), false);
			assert.notEqual(classifyBashCommand(command).decision, "allow");
		});
	}

	it("still denies strictly dangerous commands", () => {
		assert.deepEqual(classifyBashCommand("sudo rm -rf /"), {
			decision: "deny",
			reason: "recursive force removal of a root/home path is destructive",
		});
	});

	it("denies obvious secret reads", () => {
		assert.equal(isSafeCommand("rg TOKEN .env"), false);
		assert.equal(classifyBashCommand("rg TOKEN .env").decision, "deny");
		assert.equal(classifyBashCommand("grep TOKEN config/.env.local").decision, "deny");
		assert.equal(classifyPathAccess(".env", undefined, "read").decision, "deny");
		assert.equal(classifyPathAccess(".ssh/id_ed25519", undefined, "read").decision, "deny");
		assert.equal(classifyPathAccess("credentials.json", undefined, "write").decision, "review");
	});

	it("allows ordinary reads outside the current workspace", () => {
		assert.equal(classifyPathAccess("/opt/homebrew/lib/node_modules/pkg/README.md", "/workspace", "read").decision, "allow");
	});

	it("classifies bash and read-like tool calls using the same safety rules", () => {
		assert.equal(classifyToolCall("bash", { command: "find . -delete" }).decision, "review");
		assert.equal(classifyToolCall("bash", { command: "git status" }).decision, "allow");
		assert.equal(classifyToolCall("read", { path: ".env" }).decision, "deny");
		assert.equal(classifyToolCall("grep", { path: ".ssh/id_rsa", pattern: "x" }).decision, "deny");
	});
});
