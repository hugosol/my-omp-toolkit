/**
 * DeepSeek Cost Tracker — Session-level token usage and cost display.
 *
 * Shows cumulative and per-turn cost in the widget area with an inline
 * progress bar tracking context usage against a configurable budget
 * (default 220K).  Also tracks daily accumulated spend per session,
 * persisted to ~/.omp/cost-archive/deepseek-cost.json.
 *
 * Pricing (RMB per million tokens, deepseek-v4-pro):
 *   input (cache miss): ¥3     cacheRead (cache hit): ¥0.025     output: ¥6
 *
 * Commands:
 *   /budget <N>K   — Set progress bar max, session-scoped (e.g. /budget 300K).
 *   /budget detail — Toggle detail / brief display mode.
 *   /budget clear  — Archive current daily tracking file and start a fresh period.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

const DEFAULT_BUDGET = 220_000;
const BAR_WIDTH = 20;

// Segment bar constants
/** Maximum segment bar width in characters. */
const MAX_SEGMENT_BAR = 50;
/** Fine mode: 1/8 block = ¥0.05, 1 char (8 blocks) = ¥0.40, used when totalCost ≤ SCALE_THRESHOLD. */
const FINE_BLOCK_RMB = 0.05;
const BLOCKS_PER_CHAR = 8;
/** Coarse mode: 1 full block = ¥1.00, used when totalCost > SCALE_THRESHOLD. */
const COARSE_BLOCK_RMB = 1.00;
/** Threshold for switching from fine to coarse mode. */
const SCALE_THRESHOLD = 20.00;
/** Fine mode max blocks (50 chars × 8 blocks/char). */
const MAX_FINE_BLOCKS = 400;

/** Palette for per-session segment bar (8 colors, cycles). */
const SEGMENT_PALETTE = [
	"success",
	"warning",
	"error",
	"thinkingHigh",
	"thinkingXhigh",
	"syntaxType",
	"syntaxNumber",
	"syntaxKeyword",
] as const;

// ============================================================================
// Session state (widget display)
// ============================================================================
const WIDGET_KEY = "z-deepseek-cost";

let budget = DEFAULT_BUDGET;
let previousTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let lastContextTokens: number | null = null;

let turnDelta: { input: number; output: number; cacheRead: number } | null = null;
let balanceStr: string | null = null;
let detailMode = false;

// ============================================================================
// Daily tracking — persisted to ~/.omp/cost-archive/deepseek-cost.json
// ============================================================================

interface DailySession {
	id: string;
	name: string;
	lastInput: number;
	lastCacheRead: number;
	lastOutput: number;
	cost: number;
}

interface DailyData {
	start: string;
	totalCost: number;
	totalTokens: { input: number; cacheRead: number; output: number };
	sessions: DailySession[];
}

let dailyCache: DailyData | null = null;

function getArchiveDir(): string {
	const home = os.homedir();
	return path.join(home, ".omp", "cost-archive");
}

function getDailyPath(): string {
	return path.join(getArchiveDir(), "deepseek-cost.json");
}

function ensureArchiveDir(): void {
	const dir = getArchiveDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function readDaily(): DailyData {
	if (dailyCache) return dailyCache;
	try {
		const raw = fs.readFileSync(getDailyPath(), "utf-8");
		const data = JSON.parse(raw) as DailyData;
		// Normalize missing fields from older files
		data.totalTokens ??= { input: 0, cacheRead: 0, output: 0 };
		data.sessions ??= [];
		for (const s of data.sessions) {
			s.lastInput ??= 0;
			s.lastCacheRead ??= 0;
			s.lastOutput ??= 0;
			s.cost ??= 0;
		}
		dailyCache = data;
		return data;
	} catch {
		const data: DailyData = {
			start: new Date().toISOString(),
			totalCost: 0,
			totalTokens: { input: 0, cacheRead: 0, output: 0 },
			sessions: [],
		};
		dailyCache = data;
		return data;
	}
}

function writeDaily(data: DailyData): void {
	ensureArchiveDir();
	dailyCache = data;
	fs.writeFileSync(getDailyPath(), JSON.stringify(data, null, 2), "utf-8");
}

/** Archive current daily file with start/end timestamps, start a fresh one. */
function archiveDaily(): string | null {
	const data = readDaily();
	if (data.totalCost <= 0 && data.sessions.length === 0) return null;

	const end = new Date().toISOString();
	// Safe filename: replace colons
	const startSafe = data.start.replace(/[:.]/g, "-");
	const endSafe = end.replace(/[:.]/g, "-");
	const archivePath = path.join(
		getArchiveDir(),
		`deepseek-cost-${startSafe}-${endSafe}.json`,
	);

	ensureArchiveDir();
	fs.writeFileSync(archivePath, JSON.stringify({ ...data, end }, null, 2), "utf-8");

	// Start fresh
	const fresh: DailyData = {
		start: end,
		totalCost: 0,
		totalTokens: { input: 0, cacheRead: 0, output: 0 },
		sessions: [],
	};
	writeDaily(fresh);
	return archivePath;
}

/** Ensure current session is tracked in daily data (idempotent). */
function ensureSessionInDaily(
	sessionId: string,
	sessionName: string,
	stats: { input: number; cacheRead: number; output: number },
): DailyData {
	const daily = readDaily();
	let s = daily.sessions.find(e => e.id === sessionId);
	if (!s) {
		s = {
			id: sessionId,
			name: sessionName,
			lastInput: stats.input,
			lastCacheRead: stats.cacheRead,
			lastOutput: stats.output,
			cost: 0,
		};
		daily.sessions.push(s);
		writeDaily(daily);
	}
	return daily;
}

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

/** Build ¥I/O ratio string: input+cache cost % vs output cost %. Returns "--:--" when total cost is zero. */
function ioRatio(usage: { input: number; cacheRead: number; output: number }): string {
	const iCost = rmbCost(usage.input, usage.cacheRead, 0);
	const oCost = rmbCost(0, 0, usage.output);
	const total = iCost + oCost;
	if (total <= 0) return `¥I/O: --:--`;
	const iPct = Math.round((iCost / total) * 100);
	const oPct = 100 - iPct;
	return `¥I/O: ${iPct}:${oPct}`;
}

function buildStatusLine(usage: { input: number; cacheRead: number; output: number }, pad = false): string {
	const totalIn = usage.input + usage.cacheRead;
	const sum = totalIn + usage.output;
	const cost = rmbCost(usage.input, usage.cacheRead, usage.output);
	const hitRate = totalIn > 0 ? Math.round((usage.cacheRead / totalIn) * 100) : 0;
	if (pad) {
		if (detailMode) {
			const pct = String(hitRate).padStart(3);
			return `Input: ${padTokens(usage.cacheRead, PAD_IN)}/${padTokens(totalIn, PAD_IN)} (${pct}%)  Output: ${padTokens(usage.output, PAD_OUT)}  ${ioRatio(usage)}  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
		}
		return `Cache: ${String(hitRate).padStart(3)}%  ${ioRatio(usage)}  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
	}
	if (detailMode) {
		return `Input: ${fmtTokens(usage.cacheRead)}/${fmtTokens(totalIn)} (${hitRate}%)  Output: ${fmtTokens(usage.output)}  ${ioRatio(usage)}  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
	}
	return `Cache: ${hitRate}%  ${ioRatio(usage)}  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
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

/** Map a number of 1/8 blocks (1–8) to the corresponding Unicode partial block character. */
function blockChar(eighths: number): string {
	const chars = ["", "\u258F", "\u258E", "\u258D", "\u258C", "\u258B", "\u258A", "\u2589", "\u2588"];
	return chars[eighths] ?? "";
}


/**
 * Build a colored multi-segment bar showing each session's cost proportion.
 *
 * Two modes:
 * - Fine (≤ ¥20.00): 1/8 block = ¥0.05, 1 char (8 blocks) = ¥0.40.
 *   Every session with positive cost gets at least one ▏.
 * - Coarse (> ¥20.00): 1 full block █ = ¥1.00.
 *   Sessions < ¥1.00 are hidden.
 * Both modes capped at MAX_SEGMENT_BAR (50) characters.
 */
function buildSegmentBar(
	sessions: DailySession[],
	totalCost: number,
	theme: { fg: (color: string, text: string) => string },
): string {
	// Quick check: any cost at all?
	let hasCost = false;
	for (const s of sessions) { if (s.cost > 0) { hasCost = true; break; } }
	if (!hasCost || totalCost <= 0) return "";

	if (totalCost <= SCALE_THRESHOLD) {
		return buildFineBar(sessions, totalCost, theme);
	}
	return buildCoarseBar(sessions, theme);
}

/** Fine mode: 1/8 block = ¥0.05, each session ≥ 1 block (ceil). */
function buildFineBar(
	sessions: DailySession[],
	totalCost: number,
	theme: { fg: (color: string, text: string) => string },
): string {
	const entries: { color: string; rawBlocks: number }[] = [];
	let rawTotal = 0;

	for (let i = 0; i < sessions.length; i++) {
		const s = sessions[i];
		if (s.cost <= 0) continue;
		const blocks = Math.ceil(s.cost / FINE_BLOCK_RMB);
		entries.push({
			color: SEGMENT_PALETTE[i % SEGMENT_PALETTE.length],
			rawBlocks: blocks,
		});
		rawTotal += blocks;
	}
	if (entries.length === 0) return "";

	// Allocate blocks, scaling proportionally if over cap
	const blocks = scaleAlloc(rawTotal, MAX_FINE_BLOCKS, entries.map(e => e.rawBlocks));

	// Render: each session gets whole characters, last char uses partial block
	let bar = "[";
	for (let i = 0; i < entries.length; i++) {
		const b = blocks[i];
		const fullChars = Math.floor((b - 1) / BLOCKS_PER_CHAR);
		const remainder = ((b - 1) % BLOCKS_PER_CHAR) + 1;
		if (fullChars > 0) {
			bar += theme.fg(entries[i].color, "\u2588".repeat(fullChars));
		}
		bar += theme.fg(entries[i].color, blockChar(remainder));
	}
	bar += "]";
	return bar;
}

/** Coarse mode: 1 full block = ¥1.00, sessions < ¥1.00 hidden, capped at MAX_SEGMENT_BAR. */
function buildCoarseBar(
	sessions: DailySession[],
	theme: { fg: (color: string, text: string) => string },
): string {
	const entries: { color: string; rawChars: number }[] = [];
	let rawTotal = 0;

	for (let i = 0; i < sessions.length; i++) {
		const s = sessions[i];
		if (s.cost < COARSE_BLOCK_RMB) continue;
		const chars = Math.ceil(s.cost / COARSE_BLOCK_RMB);
		entries.push({
			color: SEGMENT_PALETTE[i % SEGMENT_PALETTE.length],
			rawChars: chars,
		});
		rawTotal += chars;
	}
	if (entries.length === 0) return "";

	const widths = scaleAlloc(rawTotal, MAX_SEGMENT_BAR, entries.map(e => e.rawChars));

	let bar = "[";
	for (let i = 0; i < entries.length; i++) {
		bar += theme.fg(entries[i].color, "\u2588".repeat(widths[i]));
	}
	bar += "]";
	return bar;
}

/**
 * Scale raw allocations to fit within a cap, keeping a floor of 1 per entry.
 * Returns an array of integer allocations summing to at most `max` (or cap-corrected).
 */
function scaleAlloc(rawTotal: number, cap: number, raws: number[]): number[] {
	if (rawTotal <= cap) return raws;

	const scale = cap / rawTotal;
	const allocs = raws.map(r => Math.max(1, Math.round(r * scale)));
	const sum = allocs.reduce((a, b) => a + b, 0);
	const diff = cap - sum;

	if (diff !== 0 && allocs.length > 0) {
		// Adjust the largest entry to absorb the rounding discrepancy
		let largestIdx = 0;
		for (let i = 1; i < allocs.length; i++) {
			if (allocs[i] > allocs[largestIdx]) largestIdx = i;
		}
		allocs[largestIdx] = Math.max(1, allocs[largestIdx] + diff);
	}
	return allocs;
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

	// Line 1: progress bar + balance + accrued spend + per-session segment bar
	const daily = readDaily();
	const accruedCost = daily.totalCost;
	const segBar = buildSegmentBar(daily.sessions, accruedCost, ctx.ui.theme);
	const bar = buildBar(lastContextTokens, budget);

	const parts: string[] = [];
	if (bar && lastContextTokens !== null) {
		parts.push(colorBar(bar, lastContextTokens, budget, ctx.ui.theme));
	}
	if (balanceStr) parts.push(balanceStr);
	const accruedPart = segBar
		? `\u23F3 Accrued: ${fmtCost(accruedCost)} ${segBar}`
		: `\u23F3 Accrued: ${fmtCost(accruedCost)}`;
	parts.push(accruedPart);

	if (parts.length > 0) lines.push(parts.join("  "));

	// Line 3: total session stats
	lines.push(`\u{1F4CB} Total:  ${buildStatusLine({
		input: stats.input,
		cacheRead: stats.cacheRead,
		output: stats.output,
	}, true)}`);

	// Line 4: turn stats (if available)
	if (turnDelta) {
		lines.push(`\u{1F4CA} Turn:   ${buildStatusLine(turnDelta, true)}`);
	}

	ctx.ui.setWidget(WIDGET_KEY, lines);
}

// ===========================================
// Progress bar color helper (uses theme.fg)
// ===========================================

function barColor(pct: number): "dim" | "success" | "warning" | "error" {
	if (pct < 36) return "dim";
	if (pct < 64) return "success";
	if (pct < 82) return "warning";
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
		description: "Set context budget, toggle display mode, or clear daily tracking (/budget clear)",
		handler: async (args: string, ctx) => {
			const trimmed = args?.trim() ?? "";

			// /budget clear — archive daily tracking and reset
			if (/^clear$/i.test(trimmed)) {
				const archived = archiveDaily();
				if (archived) {
					ctx.ui.notify(`Daily tracking archived → ${path.basename(archived)}`, "info");
				} else {
					ctx.ui.notify("No daily data to archive (tracking is empty).", "info");
				}
				refresh(pi, ctx);
				return;
			}

			// /budget detail — toggle display mode
			if (/^detail$/i.test(trimmed)) {
				detailMode = !detailMode;
				ctx.ui.notify(`Display: ${detailMode ? "detail" : "brief"}`, "info");
				refresh(pi, ctx);
				return;
			}

			// /budget <N>K — set budget
			const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*K?$/i);
			if (!m) {
				ctx.ui.notify("Usage: /budget <number>K | /budget detail | /budget clear", "error");
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

	// Session init — record baseline for delta tracking and ensure session
	// exists in daily JSON (writes current cumulative stats as lastKnown so
	// fork / resume don't double-count inherited tokens).
	const onInit = async (_event: unknown, ctx: ExtensionContext) => {
		const s = ctx.sessionManager.getUsageStatistics();
		previousTotal = { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
		lastContextTokens = null;
		turnDelta = null;
		balanceStr = null;

		// Ensure session is tracked in daily JSON with current stats as baseline
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionName = ctx.sessionManager.getSessionName() ?? ctx.cwd ?? "";
		ensureSessionInDaily(sessionId, sessionName, {
			input: s.input,
			cacheRead: s.cacheRead,
			output: s.output,
		});

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
		turnDelta = null;
		refresh(pi, ctx);
	});

	// Agent end (fires once per user turn, after all tool loops)
	pi.on("agent_end", async (_event, ctx) => {
		const stats = ctx.sessionManager.getUsageStatistics();
		const cur = { input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite };

		// Always update baseline so non-DeepSeek turns don't leak into
		// DeepSeek turn deltas after a model switch.
		if (ctx.model?.id !== MODEL_ID) {
			previousTotal = cur;
			return;
		}

		// --- Daily accumulation (uses lastKnown from file, not previousTotal) ---
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) {
			previousTotal = cur;
			return;
		}
		const sessionName = ctx.sessionManager.getSessionName() ?? ctx.cwd ?? "";
		try {
			const daily = ensureSessionInDaily(sessionId, sessionName, {
				input: stats.input,
				cacheRead: stats.cacheRead,
				output: stats.output,
			});

			const sess = daily.sessions.find(e => e.id === sessionId);
			if (!sess) {
				previousTotal = cur;
				return;
			}
			const deltaInput = Math.max(0, stats.input - sess.lastInput);
			const deltaCacheRead = Math.max(0, stats.cacheRead - sess.lastCacheRead);
			const deltaOutput = Math.max(0, stats.output - sess.lastOutput);

			if (deltaInput > 0 || deltaCacheRead > 0 || deltaOutput > 0) {
				const deltaCost = rmbCost(deltaInput, deltaCacheRead, deltaOutput);
				daily.totalCost += deltaCost;
				daily.totalTokens.input += deltaInput;
				daily.totalTokens.cacheRead += deltaCacheRead;
				daily.totalTokens.output += deltaOutput;

				sess.lastInput = stats.input;
				sess.lastCacheRead = stats.cacheRead;
				sess.lastOutput = stats.output;
				sess.cost += deltaCost;

				writeDaily(daily);
			}
		} catch {
			// Daily tracking is best-effort; never block the widget.
		}

		// --- Widget turn summary ---
		const delta = {
			input: cur.input - previousTotal.input,
			output: cur.output - previousTotal.output,
			cacheRead: cur.cacheRead - previousTotal.cacheRead,
		};

		turnDelta = (delta.input > 0 || delta.output > 0 || delta.cacheRead > 0) ? delta : null;

		previousTotal = cur;
		await fetchBalance(ctx);
		refresh(pi, ctx);
	});
}
