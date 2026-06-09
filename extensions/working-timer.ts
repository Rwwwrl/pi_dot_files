/**
 * Pi Working Timer Extension
 *
 * Adds elapsed time to Pi's inline working message while the agent is working.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	}
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function workingTimerExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | null = null;
	let startedAt = 0;
	let lastRenderedSecond = -1;
	let removeAbortListener: (() => void) | null = null;

	function clearAbortListener(): void {
		removeAbortListener?.();
		removeAbortListener = null;
	}

	function stopTimer(ctx: ExtensionContext): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		startedAt = 0;
		lastRenderedSecond = -1;
		clearAbortListener();
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	}

	function startTimer(ctx: ExtensionContext): void {
		stopTimer(ctx);
		if (!ctx.hasUI) return;

		startedAt = Date.now();
		const updateMessage = () => {
			const elapsedMs = Date.now() - startedAt;
			const elapsedSecond = Math.floor(elapsedMs / 1000);
			if (elapsedSecond === lastRenderedSecond) return;
			lastRenderedSecond = elapsedSecond;
			ctx.ui.setWorkingMessage(`Working... ${formatElapsed(elapsedMs)}`);
		};

		updateMessage();
		timer = setInterval(updateMessage, 250);

		const signal = ctx.signal;
		if (signal) {
			const onAbort = () => stopTimer(ctx);
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	pi.on("agent_start", async (_event, ctx) => {
		startTimer(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer(ctx);
	});
}
