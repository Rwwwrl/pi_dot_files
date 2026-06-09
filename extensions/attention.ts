/**
 * Pi Attention Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input,
 * and animates the terminal title while Pi is working.
 * Supports multiple terminal notification protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

function getBaseTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const cwd = path.basename(ctx.cwd);
	const session = pi.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

function getWorkingTitle(pi: ExtensionAPI, ctx: ExtensionContext, frame: string): string {
	return `${frame} ${getBaseTitle(pi, ctx)}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let removeAbortListener: (() => void) | null = null;

	function clearAbortListener(): void {
		removeAbortListener?.();
		removeAbortListener = null;
	}

	function stopTitleActivity(ctx: ExtensionContext): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		clearAbortListener();
		if (ctx.hasUI) ctx.ui.setTitle(getBaseTitle(pi, ctx));
	}

	function startTitleActivity(ctx: ExtensionContext): void {
		stopTitleActivity(ctx);
		if (!ctx.hasUI) return;

		const updateTitle = () => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length]!;
			ctx.ui.setTitle(getWorkingTitle(pi, ctx, frame));
			frameIndex++;
		};

		updateTitle();
		timer = setInterval(updateTitle, 80);

		const signal = ctx.signal;
		if (signal) {
			const onAbort = () => stopTitleActivity(ctx);
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	pi.on("agent_start", async (_event, ctx) => {
		startTitleActivity(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTitleActivity(ctx);
		notify("Pi", "Ready for input");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTitleActivity(ctx);
	});
}
