/**
 * anchored-standard — persona-anchored extension for Oh My Pi.
 *
 * Main sessions run with `personaText` as the system prompt for the whole
 * session. The full omp prompt is captured at each agent start; once the
 * session records its first assistant message, every context assembly gets
 * the captured prompt as a developer message at index 1 — with the omp
 * persona section ("§ Role" … "§ Runtime") stripped, so the model regains
 * omp's tool docs, skills, rules, and project context without a second
 * persona competing with the system prompt.
 *
 * omp prompt contract: the strip filter depends on the "§ Role"/"§ Runtime"
 * section markers. The base prompt is checked at `session_start` and the
 * per-turn prompt again at `before_agent_start`. Missing markers disable the
 * extension for that session — every hook returns the untouched input — and
 * the user is notified once per session (file log + visible session message;
 * TUI notify/status; stderr in print mode).
 *
 * Robustness:
 *  - Subagents (registry kind !== "main") are exempt everywhere.
 *  - Every hook degrades to the untouched input on its own failure, with a
 *    one-time warning — a bug here can never brick a session or eat context.
 *  - Invalid config fails at load time (the extension loader surfaces it).
 *  - No network calls, no telemetry.
 */

import type {
	BeforeAgentStartEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent";

import { loadConfig } from "./config";
import { createPhaseTracker, hasSessionContext, isSubagent } from "./phase";
import { stripCapturedPrompt } from "./strip";

/** Diagnostic name used by loader diagnostics. */
export const name = "anchored-standard";

// omp runs extensions under bun; import.meta.dir is the module's directory.
const extensionDir = (import.meta as unknown as { dir?: string }).dir ?? "";

const ANCHOR_BROKEN_MESSAGE =
	"anchored-standard: omp 提示词结构变化（§ Role/§ Runtime 锚点缺失），本会话已停用该扩展。";

export default async function anchoredStandard(pi: ExtensionAPI): Promise<void> {
	const { config, missing } = await loadConfig(`${extensionDir}/config.json`);
	if (!config.enabled) return;

	const warned = new Set<string>();
	const warnOnce = (key: string, message: string): void => {
		if (warned.has(key)) return;
		warned.add(key);
		try {
			pi.logger.warn(message);
		} catch {
			// Logger unavailable — the guard exists only to avoid spamming.
		}
	};
	if (missing) {
		warnOnce("config-missing", "anchored-standard: config.json not found next to index.ts; using defaults");
	}

	const tracker = createPhaseTracker(() => pi.pi.AgentRegistry.global());

	/** Latest full omp prompt captured at agent start (append source). */
	let capturedPrompt: string[] = [];
	/** Sessions whose omp prompt lost the strip markers: every hook stays untouched. */
	const anchorBroken = new Set<string>();
	/** Sessions already notified about broken anchors (one notification per session). */
	const notified = new Set<string>();

	const sessionIdOf = (ctx: ExtensionContext): string | undefined => {
		try {
			const sid = ctx.sessionManager?.getSessionId?.();
			return typeof sid === "string" && sid.length > 0 ? sid : undefined;
		} catch {
			return undefined;
		}
	};

	/** True when no captured block carries both strip markers (nothing would be stripped). */
	const anchorsBroken = (blocks: readonly string[]): boolean => !stripCapturedPrompt(blocks).stripped;

	const notifyAnchorBroken = (ctx: ExtensionContext): void => {
		const sid = sessionIdOf(ctx);
		if (!sid || notified.has(sid)) return;
		notified.add(sid);
		try {
			pi.logger.warn(ANCHOR_BROKEN_MESSAGE);
		} catch {
			// Logger unavailable — user-facing channels below still run.
		}
		try {
			pi.sendMessage(
				{
					customType: "anchored-standard/anchor-mismatch",
					content: ANCHOR_BROKEN_MESSAGE,
					display: true,
					attribution: "agent",
				},
				{ triggerTurn: false },
			);
		} catch {
			// A missing sendMessage transport must never take down session start.
		}
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(ANCHOR_BROKEN_MESSAGE, "warning");
				ctx.ui.setStatus("anchored-standard", "已停用：omp 提示词锚点缺失");
			}
		} catch {
			// UI is unavailable in headless modes.
		}
		if (ctx.mode === "print") {
			console.error(ANCHOR_BROKEN_MESSAGE);
		}
	};

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		try {
			if (isSubagent(ctx, pi.pi.AgentRegistry.global())) return;
			const sid = sessionIdOf(ctx);
			if (!sid) return;
			const current = ctx.getSystemPrompt();
			if (!Array.isArray(current) || current.length === 0) return; // nothing to check yet
			if (anchorsBroken(current.map(String))) {
				anchorBroken.add(sid);
				notifyAnchorBroken(ctx);
			}
		} catch {
			// A startup check failure must never block session start.
		}
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		if (!hasSessionContext(ctx)) return;
		try {
			// Explicit subagent gate: the real runtime re-binds a fresh extension
			// instance per session, but a shared instance must never leak a
			// captured main-session prompt into a subagent context.
			if (isSubagent(ctx, pi.pi.AgentRegistry.global())) return;
			const current = Array.isArray(event.systemPrompt) ? event.systemPrompt.map(String) : [];
			if (current.length > 0) capturedPrompt = current;
			const sid = sessionIdOf(ctx);
			if (!sid) return;
			if (anchorsBroken(current)) {
				anchorBroken.add(sid);
				notifyAnchorBroken(ctx);
				return; // keep the original prompt
			}
			anchorBroken.delete(sid); // markers recovered — self-heal
			return { systemPrompt: [config.personaText] };
		} catch (error) {
			// A filter bug must never eat the real prompt.
			warnOnce(
				"agent-start",
				`anchored-standard: before_agent_start filter failed, keeping original prompt: ${String((error as Error)?.message ?? error)}`,
			);
			return;
		}
	});

	pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
		if (!hasSessionContext(ctx)) return;
		try {
			if (isSubagent(ctx, pi.pi.AgentRegistry.global())) return;
			const sid = sessionIdOf(ctx);
			if (!sid || anchorBroken.has(sid)) return;
			if (!tracker.isPromoted(ctx)) return;
			if (!Array.isArray(event.messages) || capturedPrompt.length === 0) return;
			const { content } = stripCapturedPrompt(capturedPrompt);
			const devMessage = {
				role: "developer" as const,
				content,
				timestamp: Date.now(),
			};
			const insertAt = Math.min(1, event.messages.length);
			return {
				messages: [...event.messages.slice(0, insertAt), devMessage, ...event.messages.slice(insertAt)],
			};
		} catch (error) {
			// A filter bug must never eat the user's context.
			warnOnce(
				"context",
				`anchored-standard: context filter failed, keeping original messages: ${String((error as Error)?.message ?? error)}`,
			);
			return;
		}
	});
}
