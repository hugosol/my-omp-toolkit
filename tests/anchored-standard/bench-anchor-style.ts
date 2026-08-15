/**
 * Automated A/B for the anchored-standard trajectory anchor.
 *
 * Spawns real `omp --print` sessions and parses the persisted `.jsonl`:
 *
 *   - anchored arm: `--trusted-extension <ext>/index.ts`
 *     (omp treats trusted paths as an exact allowlist and disables extension
 *     discovery, so this arm mounts ONLY anchored-standard)
 *   - control arm:   `--no-extensions`
 *     (same discovery isolation, zero extensions)
 *
 * Both arms get a fresh workspace + fresh `--session-dir`, the same task,
 * model, and thinking level. The script measures what the dsh preset measured:
 * per reasoning block (thinking content) counts of `we`, `we need`, `let's`,
 * `let me`, visible replies, and the tools each model request actually called.
 *
 * Transcript tool calls are NOT the tool catalog the model was offered:
 * providers with owned-dialect in-band transcoding (e.g. deepseek official)
 * re-add tools after the wire-level filter, so the model can still call
 * `write` on request #1 even though the wire carried only bash/read. For that
 * reason every live run also mounts an ephemeral probe extension that records
 * the final `before_provider_request` payload — wire tools + max tokens — per
 * model request. Wire-level assertions use the probe; the transcript stays a
 * behavioral layer.
 *
 * Static unit coverage (tool narrowing, 1024 cap, persona replacement,
 * developer-message append) lives in `bun test tests/anchored-standard/` and
 * `bun tests/anchored-standard/smoke-omp.ts`.
 *
 * Usage:
 *
 *   bun tests/anchored-standard/bench-anchor-style.ts \
 *     --runs 3 \
 *     --model deepseek/deepseek-v4-pro \
 *     --thinking max \
 *     --task "Create src/counter.ts ... run `bun test src/` ..."
 *
 *   bun tests/anchored-standard/bench-anchor-style.ts --replay <session.jsonl>
 *
 * Real model calls cost money. `--task` is required in live mode on purpose:
 * the benchmark task must be a deliberate choice.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT_DIR = resolve(import.meta.dir, "..", "..", "extensions", "anchored-standard");
const EXT_ENTRY = join(EXT_DIR, "index.ts");

const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_THINKING = "max";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/**
 * Ephemeral wire probe, generated per process into a temp dir. Registered
 * AFTER anchored-standard so its `before_provider_request` handler observes
 * the payload the previous handler left behind. Lines are written to stderr
 * and parsed back by `parseWireRequests`.
 */
export const PROBE_SOURCE = `
interface WirePayload {
	payload?: unknown;
}

interface WireRecord {
	tools?: unknown[];
	max_tokens?: unknown;
	max_output_tokens?: unknown;
	max_completion_tokens?: unknown;
}

export default async function probe(pi: { on(event: "before_provider_request", handler: (event: WirePayload) => unknown): void }) {
	let request = 0;
	pi.on("before_provider_request", event => {
		request += 1;
		const record = (event.payload ?? {}) as WireRecord;
		const tools = Array.isArray(record.tools)
			? record.tools.map(tool => {
					if (typeof tool !== "object" || tool === null) return typeof tool;
					const entry = tool as Record<string, unknown>;
					const nested = entry.function;
					if (typeof entry.name === "string") return entry.name;
					if (typeof nested === "object" && nested !== null && typeof (nested as Record<string, unknown>).name === "string") {
						return (nested as Record<string, unknown>).name;
					}
					return typeof tool;
				})
			: [];
		const max = record.max_tokens ?? record.max_output_tokens ?? record.max_completion_tokens ?? null;
		console.error("ANCHOR_PROBE " + JSON.stringify({ request, tools, max }));
	});
}
`;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function parseArgs(argv: string[]) {
	const args = [...argv];
	const replay = flag(args, "replay");
	const runsRaw = flag(args, "runs");
	const runs = runsRaw === undefined ? 3 : Number.parseInt(runsRaw, 10);
	if (!Number.isSafeInteger(runs) || runs < 1) {
		throw new Error(`--runs must be a positive integer, got ${JSON.stringify(runsRaw)}`);
	}
	const timeoutRaw = flag(args, "timeout");
	const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number.parseInt(timeoutRaw, 10) * 1000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`--timeout must be positive seconds, got ${JSON.stringify(timeoutRaw)}`);
	}
	return {
		replay,
		runs,
		timeoutMs,
		task: flag(args, "task"),
		model: flag(args, "model") ?? DEFAULT_MODEL,
		thinking: flag(args, "thinking") ?? DEFAULT_THINKING,
		omp: flag(args, "omp") ?? (Bun.which("omp") ?? "omp"),
		keep: args.includes("--keep"),
		json: flag(args, "json"),
	};
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

export interface MarkerCounts {
	we: number;
	weNeed: number;
	lets: number;
	letMe: number;
}

export interface RequestStats {
	/** 1-based model request index (assistant message ordinal). */
	request: number;
	reasoningBlocks: number;
	thinkingChars: number;
	visibleReplies: number;
	visibleChars: number;
	toolNames: string[];
	markers: MarkerCounts;
}

export function countMarkers(text: string): MarkerCounts {
	const lower = text.toLowerCase();
	return {
		we: (lower.match(/\bwe\b/g) ?? []).length,
		weNeed: (lower.match(/\bwe need\b/g) ?? []).length,
		lets: (lower.match(/\blet's\b|\blets\b/g) ?? []).length,
		letMe: (lower.match(/\blet me\b/g) ?? []).length,
	};
}

/** Parse persisted session entries into per-model-request stats. */
export function parseSession(sessionFile: string): RequestStats[] {
	const text = readFileSync(sessionFile, "utf8");
	const out: RequestStats[] = [];
	let request = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null || !("type" in entry)) continue;
		if (entry.type !== "message") continue;
		const message = (entry as Record<string, unknown>).message;
		if (typeof message !== "object" || message === null) continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
		request += 1;

		const content = record.content as unknown[];
		const thinkingParts: string[] = [];
		const toolNames: string[] = [];
		const visibleParts: string[] = [];
		for (const block of content) {
			if (typeof block !== "object" || block === null || !("type" in block)) continue;
			const b = block as Record<string, unknown>;
			if (b.type === "thinking" && typeof b.thinking === "string") {
				thinkingParts.push(b.thinking);
			} else if (b.type === "toolCall" && typeof b.name === "string") {
				toolNames.push(b.name);
			} else if (b.type === "text" && typeof b.text === "string") {
				visibleParts.push(b.text);
			}
		}
		const thinkingText = thinkingParts.join("\n\n");
		const visibleText = visibleParts.join("\n");
		const uniqueTools: string[] = [];
		for (const toolName of toolNames) {
			if (!uniqueTools.includes(toolName)) uniqueTools.push(toolName);
		}
		out.push({
			request,
			reasoningBlocks: thinkingParts.length,
			thinkingChars: thinkingText.length,
			visibleReplies: visibleText.trim().length > 0 ? 1 : 0,
			visibleChars: visibleText.length,
			toolNames: uniqueTools,
			markers: countMarkers(thinkingText),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Wire payload probing
// ---------------------------------------------------------------------------

export interface WireRequest {
	/** 1-based provider request ordinal as counted by the probe. */
	request: number;
	tools: string[];
	maxTokens: number | null;
}

export function parseWireRequests(stderr: string): WireRequest[] {
	const out: WireRequest[] = [];
	for (const line of stderr.split(/\r?\n/)) {
		const marker = "ANCHOR_PROBE ";
		const idx = line.indexOf(marker);
		if (idx === -1) continue;
		try {
			const parsed = JSON.parse(line.slice(idx + marker.length)) as {
				request?: number;
				tools?: unknown[];
				max?: unknown;
			};
			const tools = Array.isArray(parsed.tools)
				? parsed.tools.filter((tool): tool is string => typeof tool === "string")
				: [];
			out.push({
				request: parsed.request ?? out.length + 1,
				tools,
				maxTokens: typeof parsed.max === "number" ? parsed.max : null,
			});
		} catch {
			// A malformed probe line must not sink the benchmark.
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Live runs
// ---------------------------------------------------------------------------

export interface RunResult {
	arm: "anchored" | "control";
	run: number;
	exitCode: number | null;
	durationMs: number;
	sessionFile?: string;
	requests: RequestStats[];
	wireRequests: WireRequest[];
	stdoutTail: string;
	stderrTail: string;
}

function newestJsonlAfter(sessionDir: string, afterMs: number): string | undefined {
	let best: string | undefined;
	let bestMtime = 0;
	for (const name of readdirSync(sessionDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const full = join(sessionDir, name);
		const st = statSync(full);
		if (st.mtimeMs < afterMs - 2000) continue;
		if (st.mtimeMs > bestMtime) {
			bestMtime = st.mtimeMs;
			best = full;
		}
	}
	return best;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		chunks.push(chunk);
	}
	const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder().decode(merged);
}

export async function runOnce(opts: {
	arm: "anchored" | "control";
	run: number;
	omp: string;
	task: string;
	model: string;
	thinking: string;
	timeoutMs: number;
	probeEntry: string;
	keep: boolean;
}): Promise<RunResult> {
	const workspace = mkdtempSync(join(tmpdir(), "anchor-style-ws-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "anchor-style-sd-"));
	// `--trusted-extension` is an exact allowlist that also disables extension
	// discovery, so both arms isolate discovery and differ only in whether
	// anchored-standard is mounted. The probe runs in both arms.
	const armFlags =
		opts.arm === "anchored"
			? ["--trusted-extension", EXT_ENTRY, "--trusted-extension", opts.probeEntry]
			: ["--trusted-extension", opts.probeEntry];
	// Multi-line argv is truncated by the omp.cmd shim; @file is the omp-native
	// full-content path (processFileArguments reads the whole file).
	const taskPath = join(workspace, ".anchor-style-task.md");
	writeFileSync(taskPath, opts.task);
	const cmdArgs = [
		opts.omp,
		"--print",
		"--print-thoughts",
		"--session-dir",
		sessionDir,
		"--model",
		opts.model,
		"--thinking",
		opts.thinking,
		"--no-title",
		"--auto-approve",
		...armFlags,
		`@${taskPath}`,
	];

	const start = Date.now();
	const proc = Bun.spawn({
		cmd: cmdArgs,
		cwd: workspace,
		stdout: "pipe",
		stderr: "pipe",
		env: Bun.env,
	});
	const killer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}, opts.timeoutMs);

	const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
	const exitCode = await proc.exited;
	clearTimeout(killer);

	const sessionFile = newestJsonlAfter(sessionDir, start);
	const requests = sessionFile ? parseSession(sessionFile) : [];

	const result: RunResult = {
		arm: opts.arm,
		run: opts.run,
		exitCode,
		durationMs: Date.now() - start,
		sessionFile,
		requests,
		wireRequests: parseWireRequests(stderr),
		stdoutTail: stdout.length <= 1000 ? stdout : `…${stdout.slice(-1000)}`,
		stderrTail: stderr.length <= 1000 ? stderr : `…${stderr.slice(-1000)}`,
	};

	// Live runs clean up by default; --keep preserves workspace and transcript.
	if (!opts.keep) {
		try {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(sessionDir, { recursive: true, force: true });
		} catch {
			// Cleanup is best-effort.
		}
	} else {
		console.error(`kept workspace=${workspace} sessionDir=${sessionDir}`);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function sumMarkers(requests: RequestStats[], predicate: (request: RequestStats) => boolean): MarkerCounts {
	return requests
		.filter(predicate)
		.map(request => request.markers)
		.reduce(
			(a, b) => ({
				we: a.we + b.we,
				weNeed: a.weNeed + b.weNeed,
				lets: a.lets + b.lets,
				letMe: a.letMe + b.letMe,
			}),
			{ we: 0, weNeed: 0, lets: 0, letMe: 0 },
		);
}

function formatMarkers(m: MarkerCounts): string {
	return `we=${m.we} weNeed=${m.weNeed} let's=${m.lets} letMe=${m.letMe}`;
}

function printReplay(requests: RequestStats[]): void {
	if (requests.length === 0) {
		console.log("No assistant messages found.");
		return;
	}
	console.log("req | reasoningBlocks | we | weNeed | let's | letMe | visible | tools");
	for (const request of requests) {
		console.log(
			[
				String(request.request).padStart(3),
				String(request.reasoningBlocks).padStart(15),
				String(request.markers.we).padStart(3),
				String(request.markers.weNeed).padStart(6),
				String(request.markers.lets).padStart(5),
				String(request.markers.letMe).padStart(5),
				String(request.visibleReplies).padStart(7),
				` ${request.toolNames.length > 0 ? request.toolNames.join("+") : "text-only"}`,
			].join(" | "),
		);
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.replay) {
		printReplay(parseSession(args.replay));
		return;
	}
	if (!args.task) {
		console.error("bench-anchor-style: --task is required in live mode (real model calls cost money).");
		process.exit(2);
	}

	const probeDir = mkdtempSync(join(tmpdir(), "anchor-style-probe-"));
	const probeEntry = join(probeDir, "probe.ts");
	writeFileSync(probeEntry, PROBE_SOURCE);
	console.log(`model=${args.model} thinking=${args.thinking} runs=${args.runs}`);
	console.log(
		"(anchored arm = anchored-standard + wire probe: persona full-session, stripped append, wire untouched; " +
			"control arm = wire probe only; both use --trusted-extension allowlist)",
	);
	console.log(`task: ${args.task}\n`);

	const results: RunResult[] = [];
	for (const arm of ["anchored", "control"] as const) {
		for (let run = 1; run <= args.runs; run += 1) {
			process.stderr.write(`[${arm} ${run}/${args.runs}] running…\n`);
			const result = await runOnce({
				arm,
				run,
				omp: args.omp,
				task: args.task,
				model: args.model,
				thinking: args.thinking,
				timeoutMs: args.timeoutMs,
				probeEntry,
				keep: args.keep,
			});
			results.push(result);
			const first = result.requests[0];
			const firstWire = result.wireRequests[0];
			console.log(
				[
					`${result.arm.padEnd(8)} run=${result.run}`,
					`exit=${result.exitCode}`,
					`dur=${(result.durationMs / 1000).toFixed(1)}s`,
					`req#1 ${formatMarkers(sumMarkers(result.requests, request => request.request === 1))}`,
					`req#2+ ${formatMarkers(sumMarkers(result.requests, request => request.request > 1))}`,
					`blocks=${result.requests.reduce((sum, request) => sum + request.reasoningBlocks, 0)}`,
					`visible=${result.requests.reduce((sum, request) => sum + request.visibleReplies, 0)}`,
					`firstTools=${first ? first.toolNames.join("+") || "text-only" : "none"}`,
					`wire#1=${firstWire ? `${firstWire.tools.join("+") || "no-tools"}/${firstWire.maxTokens}` : "missing"}`,
				].join(" | "),
			);
			if (result.exitCode !== 0) {
				console.error(`stderr tail: ${result.stderrTail}`);
			}
		}
	}

	rmSync(probeDir, { recursive: true, force: true });

	const anchoredRequests = results.filter(result => result.arm === "anchored").flatMap(result => result.requests);
	const controlRequests = results.filter(result => result.arm === "control").flatMap(result => result.requests);
	console.log("\nAggregate request #1 markers");
	console.log(`anchored: ${formatMarkers(sumMarkers(anchoredRequests, request => request.request === 1))}`);
	console.log(`control : ${formatMarkers(sumMarkers(controlRequests, request => request.request === 1))}`);
	console.log("\nAggregate request #2+ markers");
	console.log(`anchored: ${formatMarkers(sumMarkers(anchoredRequests, request => request.request > 1))}`);
	console.log(`control : ${formatMarkers(sumMarkers(controlRequests, request => request.request > 1))}`);
	console.log("\nTool sequences");
	for (const result of results) {
		const sequence = result.requests
			.map(request => (request.toolNames.length > 0 ? request.toolNames.join("+") : "text-only"))
			.join(" → ");
		console.log(`${result.arm.padEnd(8)} run=${result.run}: ${sequence}`);
	}

	if (args.json) {
		writeFileSync(
			args.json,
			JSON.stringify(
				{ args: { ...args, task: args.task }, results },
				null,
				2,
			),
		);
		console.log(`\nJSON written to ${args.json}`);
	}
}

const entryMeta = import.meta as unknown as { main?: boolean };
if (entryMeta.main) {
	await main();
}
