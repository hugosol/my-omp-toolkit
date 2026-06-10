/**
 * DeepSeek Cost Tracker — Session-level token usage and cost display.
 *
 * Shows cumulative and per-turn cost in the widget area with an inline
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
const WIDGET_KEY = "z-deepseek-cost";


let budget = DEFAULT_BUDGET;
let previousTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let lastContextTokens: number | null = null;

let turnSummary: string | null = null;
let balanceStr: string | null = null;
let detailMode = false;
// ============================================================================
// Helpers
// ============================================================================

function fmtTokens(n: number): string {
	if (n >= 100_000) {
		const k = n / 1000;
		const whole = Math.floor(k);
		const frac = Math.round((k - whole) * 10);
		const carry = frac >= 10 ? 1 : 0;
		const adjusted = whole + carry;
		const finalFrac = carry ? 0 : frac;
		return `${adjusted.toLocaleString("en-US")}.${finalFrac}K`;
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
const PAD_SUM = 7;
function padTokens(n: number, width: number): string {
	return fmtTokens(n).padStart(width);
}

function padCost(cost: number): string {
	return fmtCost(cost).padStart(PAD_COST);
}

function padSum(sum: number): string {
	return fmtTokens(sum).padStart(PAD_SUM);
}
function buildStatusLine(usage: { input: number; cacheRead: number; output: number }, pad = false): string {
	const totalIn = usage.input + usage.cacheRead;
	const sum = totalIn + usage.output;
	const cost = rmbCost(usage.input, usage.cacheRead, usage.output);
	const hitRate = totalIn > 0 ? Math.round((usage.cacheRead / totalIn) * 100) : 0;
	if (pad) {
		if (detailMode) {
			const pct = String(hitRate).padStart(3);
			return `Input: ${padTokens(usage.cacheRead, PAD_IN)}/${padTokens(totalIn, PAD_IN)} (${pct}%)  Output: ${padTokens(usage.output, PAD_OUT)}  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
		}
		return `Cache: ${String(hitRate).padStart(3)}%  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
	}
	if (detailMode) {
		return `Input: ${fmtTokens(usage.cacheRead)}/${fmtTokens(totalIn)} (${hitRate}%)  Output: ${fmtTokens(usage.output)}  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
	}
	return `Cache: ${hitRate}%  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
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
	return `[\u2588${filled > 0 ? `\u2588`.repeat(filled - 1) : ""}${"\u2591".repeat(empty)} ${pct.toFixed(0).padStart(3)}% (${fmtTokens(tokenCount)}/${fmtTokens(max)})]`;
}

// ============================================================================
// Balance
// ============================================================================

const BALANCE_PROVIDER = "deepseek";

async function fetchBalance(ctx: ExtensionContext): Promise<void> {
	try {
		const resolver = ctx.modelRegistry.resolver(BALANCE_PROVIDER);
		const apiKey = await resolver({ lastChance: false, error: undefined });
		if (!apiKey) { balanceStr = "\u{1F4B0} Bal: N/A"; return; }
		const rawBase = ctx.modelRegistry.getProviderBaseUrl(BALANCE_PROVIDER) ?? "https://api.deepseek.com";
		const base = rawBase.replace(/\/v1\/?$/, "");
		const resp = await fetch(`${base}/user/balance`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) { balanceStr = "\u{1F4B0} Bal: N/A"; return; }
		const data = await resp.json() as { balance_infos?: Array<{ currency: string; total_balance: string }> };
		const cny = data.balance_infos?.find(b => b.currency === "CNY");
		if (cny) {
			const amt = parseFloat(cny.total_balance);
			balanceStr = `\u{1F4B0} Bal: ¥${amt.toFixed(2)}`;
		} else {
			balanceStr = "\u{1F4B0} Bal: N/A";
		}
	} catch {
		balanceStr = "\u{1F4B0} Bal: N/A";
	}
}

// ============================================================================
// UI refresh
// ============================================================================
function refresh(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	if (ctx.model?.id !== MODEL_ID) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const stats = ctx.sessionManager.getUsageStatistics();
	const cu = ctx.getContextUsage();
	lastContextTokens = cu?.tokens ?? lastContextTokens;

	const lines: string[] = [];

	// Line 1: colored progress bar (with balance if available)
	const bar = buildBar(lastContextTokens, budget);
	if (bar && lastContextTokens !== null) {
		const colored = colorBar(bar, lastContextTokens, budget, ctx.ui.theme);
		lines.push(balanceStr ? `${colored}  ${balanceStr}` : colored);
	}

	// Line 2: total stats
	lines.push(`\u{1F4CB} Total:  ${buildStatusLine({
		input: stats.input,
		cacheRead: stats.cacheRead,
		output: stats.output,
	}, true)}`);

	// Line 3: turn stats (if available)
	if (turnSummary) {
		lines.push(turnSummary);
	}

	ctx.ui.setWidget(WIDGET_KEY, lines);
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
		description: "Set context budget (e.g. /budget 300K) or toggle display mode (/budget detail)",
		handler: async (args: string, ctx) => {
			const trimmed = args?.trim() ?? "";
			if (/^detail$/i.test(trimmed)) {
				detailMode = !detailMode;
				ctx.ui.notify(`Display: ${detailMode ? "detail" : "brief"}`, "info");
				refresh(pi, ctx);
				return;
			}
			const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*K?$/i);
			if (!m) {
				ctx.ui.notify("Usage: /budget <number>K | /budget detail", "error");
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
	const onInit = async (_event: unknown, ctx: ExtensionContext) => {
		const s = ctx.sessionManager.getUsageStatistics();
		previousTotal = { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
		lastContextTokens = null;
		turnSummary = null;
		balanceStr = null;
		refresh(pi, ctx);
		await fetchBalance(ctx);
		refresh(pi, ctx);
	};

	pi.on("session_start", onInit);
	pi.on("session_branch", onInit);
	pi.on("session_switch", onInit);
	pi.on("session_tree", onInit);


	// Clear turn summary when agent starts a new run
	pi.on("agent_start", (_event, ctx) => {
		turnSummary = null;
		refresh(pi, ctx);
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
		await fetchBalance(ctx);
		refresh(pi, ctx);
	});
}
