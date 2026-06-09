/**
 * Plan markdown artifact naming, persistence, and change summaries.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/g, "");
	return slug || "plan";
}

export function extractPlanTitle(planText: string): string | undefined {
	const heading = planText.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading.replace(/[#*_`]/g, "").trim();

	const titleLine = planText.match(/^\*{0,2}Title:\*{0,2}\s*(.+)$/im)?.[1]?.trim();
	if (titleLine) return titleLine.replace(/[#*_`]/g, "").trim();

	return undefined;
}

export function inferPlanTitle(userPrompt: string, planText: string): string {
	return extractPlanTitle(planText) ?? userPrompt.split("\n")[0]?.trim() ?? "plan";
}

export function shouldPersistPlanText(text: string): boolean {
	return /\bPlan:\s*\n/i.test(text) || (/^#\s+.+$/m.test(text) && /^\s*\d+[.)]\s+/m.test(text));
}

export function isSafePlanFile(ctx: ExtensionContext, planFile: string): boolean {
	const plansDir = resolve(ctx.cwd, "plans");
	const absolutePath = resolve(ctx.cwd, planFile);
	return absolutePath.startsWith(`${plansDir}${sep}`) && planFile.endsWith(".md");
}

export async function createUniquePlanFile(ctx: ExtensionContext, title: string): Promise<string> {
	const slug = slugify(title);
	for (let index = 0; ; index++) {
		const suffix = index === 0 ? "" : `-${index + 1}`;
		const candidate = `plans/${slug}${suffix}.md`;
		try {
			await readFile(resolve(ctx.cwd, candidate), "utf8");
		} catch {
			return candidate;
		}
	}
}

export async function savePlanArtifact(
	ctx: ExtensionContext,
	activePlanFile: string | undefined,
	planText: string,
	userPrompt: string,
): Promise<{ file: string; created: boolean }> {
	await mkdir(resolve(ctx.cwd, "plans"), { recursive: true });

	const planFile =
		activePlanFile && isSafePlanFile(ctx, activePlanFile)
			? activePlanFile
			: await createUniquePlanFile(ctx, inferPlanTitle(userPrompt, planText));

	const absolutePath = resolve(ctx.cwd, planFile);
	let previous = "";
	try {
		previous = await readFile(absolutePath, "utf8");
	} catch {
		previous = "";
	}

	const next = `${planText.trimEnd()}\n`;
	await writeFile(absolutePath, next, "utf8");

	return {
		file: planFile,
		created: previous.trim().length === 0,
	};
}
