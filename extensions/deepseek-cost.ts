/**
 * DeepSeek Cost Tracker — Session-level token usage and cost display.
 *
 * Shows cumulative and per-turn cost in the status bar with an inline
 * progress bar tracking context usage against a configurable budget
 * (default 250K).
 *
 * Pricing (RMB per million tokens, deepseek-v4-pro):
 *   input (cache miss): ¥3     cacheRead (cache hit): ¥0.025     output: ¥6
 *
 * Commands:
 *   /budget <N>K  — Set progress bar max, session-scoped (e.g. /budget 300K).
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

const MODEL_ID = "deepseek-v4-pro";

const PRICE_RMB_PER_1M = {
	input: 3,
	cacheRead: 0.025,
	output: 6,
} as const;

const DEFAULT_BUDGET = 250_000;
const BAR_WIDTH = 20;

// ============================================================================
// Session state
const STATUS_KEY = "z-deepseek-cost";
const TURN_KEY = "z-deepseek-turn";

let budget = DEFAULT_BUDGET;
let previousTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let lastContextTokens: number | null = null;

let turnSummary: string | null = null;

// ============================================================================
// Helpers
// ============================================================================

function fmtTokens(n: number): string {
	if (n >= 100_000) {
		const k = n / 1000;
		return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
	}
	return n.toLocaleString("en-US");
}

function rmbCost(input: number, cacheRead: number, output: number): number {
	return (
		(input * PRICE_RMB_PER_1M.input) / 1_000_000 +
		(cacheRead * PRICE_RMB_PER_1M.cacheRead) / 1_000_000 +
		(output * PRICE_RMB_PER_1M.output) / 1_000_000
	);
}

function fmtCost(cost: number): string {
	return cost >= 0.01 ? `¥${cost.toFixed(2)}` : `¥${cost.toFixed(4)}`;
}

const PAD_IN = 7;
const PAD_OUT = 8;
const PAD_COST = 10;

function padTokens(n: number, width: number): string {
	return fmtTokens(n).padStart(width);
}

function padCost(cost: number): string {
	return fmtCost(cost).padStart(PAD_COST);
}

function buildStatusLine(usage: { input: number; cacheRead: number; output: number }, pad = false): string {
	const totalIn = usage.input + usage.cacheRead;
	const cost = rmbCost(usage.input, usage.cacheRead, usage.output);
	const hitRate = totalIn > 0 ? Math.round((usage.cacheRead / totalIn) * 100) : 0;
	if (pad) {
		const pct = String(hitRate).padStart(3);
		return `Input: ${padTokens(usage.cacheRead, PAD_IN)}/${padTokens(totalIn, PAD_IN)} (${pct}%)  Output: ${padTokens(usage.output, PAD_OUT)}  Cost: ${padCost(cost)}`;
	}
	return `Input: ${fmtTokens(usage.cacheRead)}/${fmtTokens(totalIn)} (${hitRate}%)  Output: ${fmtTokens(usage.output)}  Cost: ${fmtCost(cost)}`;
}

/**
 * Build an ASCII progress bar string (no ANSI — coloring is applied by the
 * caller with theme.fg if desired).
 */
function buildBar(tokenCount: number | null, max: number): string {
	if (tokenCount === null || tokenCount === undefined || max <= 0) return "";
	const pct = (tokenCount / max) * 100;
	const clamped = Math.min(100, Math.max(0, pct));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);
	const empty = BAR_WIDTH - filled;
	return `[\u2588${filled > 0 ? `\u2588`.repeat(filled - 1) : ""}${"\u2591".repeat(empty)} ${pct.toFixed(0).padStart(3)}% (Max:${fmtTokens(max)})]`;
}

// ============================================================================
// UI refresh
// ============================================================================

function refresh(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	if (ctx.model?.id !== MODEL_ID) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setStatus(TURN_KEY, undefined);
		return;
	}

	const stats = ctx.sessionManager.getUsageStatistics();
	const cu = ctx.getContextUsage();
	lastContextTokens = cu?.tokens ?? lastContextTokens;

	const bar = buildBar(lastContextTokens, budget);
	const totalLine = `\u{1F4CB} Total:  ${buildStatusLine({
		input: stats.input,
		cacheRead: stats.cacheRead,
		output: stats.output,
	}, true)}`;

	const line = bar ? `${bar}\n${totalLine}` : totalLine;
	ctx.ui.setStatus(STATUS_KEY, line);

	if (turnSummary) {
		ctx.ui.setStatus(TURN_KEY, turnSummary);
	} else {
		ctx.ui.setStatus(TURN_KEY, undefined);
	}
}

// ===========================================
// Progress bar color helper (uses theme.fg)
// ===========================================

function barColor(pct: number): "dim" | "success" | "warning" | "thinkingHigh" | "error" {
	if (pct < 25) return "dim";
	if (pct < 50) return "success";
	if (pct < 75) return "warning";
	if (pct <= 100) return "thinkingHigh";
	return "error";
}

function colorBar(bar: string, tokens: number, max: number, theme: { fg: (color: string, text: string) => string }): string {
	const pct = (tokens / max) * 100;
	return theme.fg(barColor(pct), bar);
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function deepseekCost(pi: ExtensionAPI): void {
	pi.setLabel("DeepSeek Cost Tracker");

	pi.registerCommand("budget", {
		description: "Set context budget threshold (e.g. /budget 300K, /budget 500)",
		handler: async (args: string, ctx) => {
			const m = args?.trim().match(/^(\d+(?:\.\d+)?)\s*K?$/i);
			if (!m) {
				ctx.ui.notify("Usage: /budget <number>K (e.g. /budget 300K)", "error");
				return;
			}
			budget = Math.round(parseFloat(m[1]) * 1000);
			if (budget <= 0) {
				budget = DEFAULT_BUDGET;
				ctx.ui.notify(`Budget must be > 0, reset to ${fmtTokens(DEFAULT_BUDGET)}`, "warning");
			} else {
				ctx.ui.notify(`Budget: ${fmtTokens(budget)}`, "info");
			}
			refresh(pi, ctx);
		},
	});

	// Session init
	const onInit = (_event: unknown, ctx: ExtensionContext) => {
		const s = ctx.sessionManager.getUsageStatistics();
		previousTotal = { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
		lastContextTokens = null;
		turnSummary = null;
		refresh(pi, ctx);
	};

	pi.on("session_start", onInit);
	pi.on("session_branch", onInit);
	pi.on("session_switch", onInit);
	pi.on("session_tree", onInit);


	// Clear turn summary when agent starts a new run
	pi.on("agent_start", (_event, ctx) => {
		turnSummary = null;
		if (ctx.hasUI) ctx.ui.setStatus(TURN_KEY, undefined);
	});
	// Agent end (fires once per user turn, after all tool loops)
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model?.id !== MODEL_ID) return;

		const stats = ctx.sessionManager.getUsageStatistics();
		const cur = { input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite };

		const delta = {
			input: cur.input - previousTotal.input,
			output: cur.output - previousTotal.output,
			cacheRead: cur.cacheRead - previousTotal.cacheRead,
		};

		if (delta.input > 0 || delta.output > 0 || delta.cacheRead > 0) {
			turnSummary = `\u{1F4CA} Turn:   ${buildStatusLine(delta, true)}`;
		} else {
			turnSummary = null;
		}

		previousTotal = cur;
		refresh(pi, ctx);
	});
}
