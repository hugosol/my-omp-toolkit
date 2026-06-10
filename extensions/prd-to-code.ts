/**
 * PRD-to-Code Extension — Autonomous two-phase workflow.
 *
 * Phase 1: /to-issues  → generate issue files from PRD
 * Phase 2: /tdd         → develop based on issue files
 *
 * Usage: /prd-to-code <slug>
 *   PRD at:  .scratch/<slug>/PRD.md
 *   Issues:  .scratch/<slug>/issues/*.md
 */

import * as fs from "node:fs/promises";
import { discoverSkills, type ExtensionAPI, type ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// State
// ============================================================================

let currentPhase: "idle" | "phase1" = "idle";
let currentSlug: string | undefined;
let replyCount = 0;

// ============================================================================
// Constants
// ============================================================================

const SKILL_PROMPT_TYPE = "skill-prompt";
const FIRST_REPLY = "请你仔细思考后回答这些问题";
const PUBLISH_REPLY = "请发布issue文件";

// ============================================================================
// Helpers
// ============================================================================

async function hasIssueFiles(slug: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(`.scratch/${slug}/issues`);
		return entries.some(e => e.endsWith(".md"));
	} catch {
		return false;
	}
}

/**
 * Build a skill-prompt message body matching OMP's internal format.
 * Skill body (without YAML frontmatter) + metadata footer.
 */
async function buildSkillMessage(skillFilePath: string, userArgs: string): Promise<string> {
	const content = await Bun.file(skillFilePath).text();
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const metaLines = [`Skill: ${skillFilePath}`];
	if (userArgs) metaLines.push(`User: ${userArgs}`);
	return `${body}\n\n---\n\n${metaLines.join("\n")}`;
}

async function activateSkill(
	pi: ExtensionAPI,
	skillName: string,
	userArgs: string,
): Promise<boolean> {
	const { skills } = await discoverSkills();
	const skill = skills.find(s => s.name === skillName);
	if (!skill) return false;

	const message = await buildSkillMessage(skill.filePath, userArgs);

	pi.sendMessage(
		{
			customType: SKILL_PROMPT_TYPE,
			content: message,
			display: false,
			details: { name: skill.name, path: skill.filePath, args: userArgs || undefined },
			attribution: "user",
		},
		{ triggerTurn: true },
	);

	return true;
}

// ============================================================================
// Phase 2: start TDD
// ============================================================================

async function startPhase2(pi: ExtensionAPI, slug: string): Promise<void> {
	await activateSkill(
		pi,
		"tdd",
		`请根据以下目录中的 issue 文件进行开发：.scratch/${slug}/issues`,
	);
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function prdToCode(pi: ExtensionAPI): void {
	pi.setLabel("PRD-to-Code");

	pi.on("agent_end", async (_event, _ctx) => {
		console.log("[prd-to-code] agent_end:", { phase: currentPhase, slug: currentSlug, replyCount });

		if (currentPhase !== "phase1" || !currentSlug) return;

		if (await hasIssueFiles(currentSlug)) {
			console.log("[prd-to-code] issues found, transitioning to Phase 2");
			currentPhase = "idle";
			const slug = currentSlug;
			currentSlug = undefined;
			await startPhase2(pi, slug);
		} else {
			const msg = replyCount === 0 ? FIRST_REPLY : PUBLISH_REPLY;
			console.log("[prd-to-code] no issues, sending:", msg);
			pi.sendUserMessage(msg, { deliverAs: "followUp" });
			replyCount++;
		}
	});

	pi.registerCommand("prd-to-code", {
		description: "Autonomous PRD → Issues → Code workflow",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const slug = args.trim();

			if (!slug) {
				ctx.ui.notify("用法: /prd-to-code <slug>", "error");
				return;
			}

			const prd = `.scratch/${slug}/PRD.md`;
			try {
				await Bun.file(prd).text();
			} catch {
				ctx.ui.notify(`PRD 文件不存在: ${prd}`, "error");
				return;
			}

			const { skills } = await discoverSkills();
			const hasToIssues = skills.some(s => s.name === "to-issues");
			const hasTdd = skills.some(s => s.name === "tdd");

			if (!hasToIssues || !hasTdd) {
				const missing = [!hasToIssues && "to-issues", !hasTdd && "tdd"]
					.filter(Boolean)
					.join(", ");
				ctx.ui.notify(`缺少技能: ${missing}。请检查技能安装。`, "error");
				return;
			}

			currentPhase = "phase1";
			currentSlug = slug;
			replyCount = 0;
			const success = await activateSkill(
				pi,
				"to-issues",
				`请分析以下PRD，生成独立的 issue 文件。PRD 路径：${prd}`,
			);

			if (!success) {
				currentPhase = "idle";
				currentSlug = undefined;
				ctx.ui.notify("无法激活 to-issues 技能", "error");
			}
		},
	});
}
