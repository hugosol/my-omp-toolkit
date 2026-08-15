/**
 * Minimal trigger-matrix for the anchored-standard trajectory anchor.
 *
 * 4 arms x N reps single-request probes, DeepSeek V4 Pro, thinking=max
 * (--reps N, default 4):
 *
 *   A anchored    persona + cap 1024 + wire tool narrowing
 *   B persona-only  persona replacement only (no cap, no narrowing)
 *   C cap-only      max_tokens 1024 only (full prompt, full catalog)
 *   D control       untouched omp request
 *
 * Every arm mounts an ephemeral matrix probe that logs the final wire payload
 * and exits the process on the SECOND before_provider_request — the first
 * request is the only one billed; its assistant message is already persisted.
 *
 * The task forbids tool calls, so the first reply should be text-only and the
 * loop would end naturally in any case.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countMarkers, parseWireRequests, type MarkerCounts } from "./bench-anchor-style";

const MODEL = "deepseek/deepseek-v4-pro";
const THINKING = "max";
const REPS = 4;
const WORKSPACE = "E:/Developer/myhub/dsh/modeltest/workspace";
const ANCHORED_ENTRY = join(import.meta.dir, "..", "..", "extensions", "anchored-standard", "index.ts");
const ANCHORED_CONFIG = join(import.meta.dir, "..", "..", "extensions", "anchored-standard", "config.json");

const TASK =
	"你正在接手一个本地护理/睡眠联调工程（Project2），工作区仅限当前可见的 workspace 目录。";

const MATRIX_PROBE_SOURCE = `
interface WirePayload {
	payload?: unknown;
}

function toolNameOf(tool: unknown): string | undefined {
	if (typeof tool !== "object" || tool === null) return undefined;
	if (!("name" in tool) || typeof tool.name !== "string") {
		if (!("function" in tool)) return undefined;
		const nested = tool.function;
		if (typeof nested !== "object" || nested === null || !("name" in nested)) return undefined;
		const nestedName = nested.name;
		return typeof nestedName === "string" && nestedName.length > 0 ? nestedName : undefined;
	}
	return tool.name.length > 0 ? tool.name : undefined;
}

export default function matrixProbe(pi: { on(event: "before_provider_request", handler: (event: WirePayload) => unknown): void }) {
	let request = 0;
	pi.on("before_provider_request", event => {
		request += 1;
		const payload = event.payload;
		const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
		const tools = "tools" in record && Array.isArray(record.tools)
			? record.tools.map(toolNameOf).filter((name): name is string => name !== undefined)
			: [];
		let max: unknown = null;
		for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
			if (field in record && typeof record[field] === "number") {
				max = record[field];
				break;
			}
		}
		console.error("ANCHOR_PROBE " + JSON.stringify({ request, tools, max }));
		if (request > 1) {
			process.exit(0);
		}
	});
}
`;

type Arm = "A" | "B" | "C" | "D";

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function parseArgs(argv: string[]) {
	const repsRaw = flag(argv, "reps");
	const reps = repsRaw === undefined ? REPS : Number.parseInt(repsRaw, 10);
	if (!Number.isSafeInteger(reps) || reps < 1) {
		throw new Error(`--reps must be a positive integer, got ${JSON.stringify(repsRaw)}`);
	}
	return { reps };
}

interface RunRecord {
	arm: Arm;
	rep: number;
	exitCode: number | null;
	durationMs: number;
	wireTools: string[];
	wireMaxTokens: number | null;
	markers: MarkerCounts;
	opening: string;
	usage: Record<string, unknown> | null;
	sessionFile?: string;
	runDir: string;
}

function personaText(): string {
	const parsed = JSON.parse(readFileSync(ANCHORED_CONFIG, "utf8")) as { personaText: string };
	return parsed.personaText;
}

function writeVariant(dir: string, name: string, source: string): string {
	mkdirSync(dir, { recursive: true });
	const entry = join(dir, `${name}.ts`);
	writeFileSync(entry, source);
	return entry;
}

function personaOnlySource(persona: string): string {
	return `
export default function personaOnly(pi: { on(event: "before_agent_start", handler: (event: unknown) => unknown): void }) {
	pi.on("before_agent_start", () => ({ systemPrompt: [${JSON.stringify(persona)}] }));
}
`;
}

function capOnlySource(cap: number): string {
	return `
interface WirePayload {
	payload?: unknown;
}

export default function capOnly(pi: { on(event: "before_provider_request", handler: (event: WirePayload) => unknown): void }) {
	pi.on("before_provider_request", event => {
		const payload = event.payload;
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
		const record = payload;
		for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
			if (field in record && typeof record[field] === "number" && Number.isFinite(record[field]) && record[field] > ${cap}) {
				return { ...record, [field]: ${cap} };
			}
		}
		return undefined;
	});
}
`;
}

function newestJsonl(dir: string): string | undefined {
	let best: string | undefined;
	let bestMtime = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.mtimeMs > bestMtime) {
			bestMtime = st.mtimeMs;
			best = full;
		}
	}
	return best;
}

function thinkingText(block: unknown): string | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	if (!("type" in block) || block.type !== "thinking") return undefined;
	if (!("thinking" in block)) return undefined;
	const text = block.thinking;
	return typeof text === "string" ? text : undefined;
}

function parseFirstThinking(sessionFile: string | undefined): { markers: MarkerCounts; opening: string; usage: Record<string, unknown> | null } {
	if (!sessionFile) {
		return { markers: { we: 0, weNeed: 0, lets: 0, letMe: 0 }, opening: "", usage: null };
	}
	const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/);
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		let entry: { type?: string; message?: { role?: string; content?: unknown[]; usage?: Record<string, unknown> } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const thinking = message.content
			.map(thinkingText)
			.filter((text): text is string => text !== undefined)
			.join("\n\n");
		return {
			markers: countMarkers(thinking),
			opening: thinking.trim().slice(0, 400),
			usage: message.usage ?? null,
		};
	}
	return { markers: { we: 0, weNeed: 0, lets: 0, letMe: 0 }, opening: "", usage: null };
}

function classify(opening: string, markers: MarkerCounts): "minimal-like" | "standard-like" | "ambiguous" {
	if (/^\s*we need\b/i.test(opening) && markers.we > 0 && markers.letMe === 0) {
		return "minimal-like";
	}
	if (/\blet me\b/i.test(opening) || markers.letMe > 0) {
		return "standard-like";
	}
	return "ambiguous";
}

async function runOne(opts: {
	arm: Arm;
	rep: number;
	runDir: string;
	sessionDir: string;
	probeEntry: string;
	variantEntries: string[];
}): Promise<RunRecord> {
	const cmdArgs = [
		Bun.which("omp") ?? "omp",
		"--print",
		"--print-thoughts",
		"--session-dir",
		opts.sessionDir,
		"--model",
		MODEL,
		"--thinking",
		THINKING,
		"--no-title",
		...opts.variantEntries.flatMap(entry => ["--trusted-extension", entry]),
		"--trusted-extension",
		opts.probeEntry,
	];
	const start = Date.now();
	const proc = Bun.spawn({
		cmd: cmdArgs,
		cwd: WORKSPACE,
		stdin: "pipe",
		stdout: Bun.file(join(opts.runDir, "stdout.log")),
		stderr: Bun.file(join(opts.runDir, "stderr.log")),
		env: Bun.env,
	});
	// stdin carries the raw task text — @file would wrap it in file-attribution
	// meta that changes the first reasoning block.
	proc.stdin.write(TASK);
	proc.stdin.end();
	const killer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}, 5 * 60_000);
	const exitCode = await proc.exited;
	clearTimeout(killer);

	const sessionFile = newestJsonl(opts.sessionDir);
	const wire = parseWireRequests(readFileSync(join(opts.runDir, "stderr.log"), "utf8"));
	const first = wire[0];
	const { markers, opening, usage } = parseFirstThinking(sessionFile);
	return {
		arm: opts.arm,
		rep: opts.rep,
		exitCode,
		durationMs: Date.now() - start,
		wireTools: first?.tools ?? [],
		wireMaxTokens: first?.maxTokens ?? null,
		markers,
		opening,
		usage,
		sessionFile,
		runDir: opts.runDir,
	};
}

async function main(): Promise<void> {
	const { reps } = parseArgs(process.argv.slice(2));
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const root = join(import.meta.dir, "matrix-runs", timestamp);
	mkdirSync(root, { recursive: true });

	const variants = mkdtempSync(join(tmpdir(), "anchor-matrix-"));
	const persona = personaText();
	const cap = 1024;
	const probeEntry = writeVariant(variants, "probe", MATRIX_PROBE_SOURCE);
	const personaEntry = writeVariant(variants, "persona-only", personaOnlySource(persona));
	const capEntry = writeVariant(variants, "cap-only", capOnlySource(cap));

	const armEntries: Record<Arm, string[]> = {
		A: [ANCHORED_ENTRY],
		B: [personaEntry],
		C: [capEntry],
		D: [],
	};

	console.log(`model=${MODEL} thinking=${THINKING} reps=${reps} persona=${JSON.stringify(persona)} cap=${cap}`);
	console.log(`workspace=${WORKSPACE}`);
	console.log(`results=${root}`);
	console.log(`task=${TASK}\n`);

	const records: RunRecord[] = [];
	for (const arm of ["A", "B", "C", "D"] as Arm[]) {
		for (let rep = 1; rep <= reps; rep += 1) {
			const runDir = join(root, `${arm}-${rep}`);
			const sessionDir = join(runDir, "session");
			mkdirSync(runDir, { recursive: true });
			mkdirSync(sessionDir, { recursive: true });
			const record = await runOne({ arm, rep, runDir, sessionDir, probeEntry, variantEntries: armEntries[arm] });
			records.push(record);
			writeFileSync(join(root, "records.json"), JSON.stringify(records, null, 2));
			const firstLine = record.opening.split("\n")[0].slice(0, 90);
			console.log(
				[
					`${record.arm}-${record.rep}`,
					`exit=${record.exitCode}`,
					`dur=${(record.durationMs / 1000).toFixed(1)}s`,
					`wire=${record.wireTools.join("+")}/${record.wireMaxTokens ?? "-"}`,
					`we=${record.markers.we} weNeed=${record.markers.weNeed} let's=${record.markers.lets} letMe=${record.markers.letMe}`,
					classify(record.opening, record.markers),
					`usage=${record.usage ? JSON.stringify(record.usage) : "missing"}`,
					`open="${firstLine}"`,
				].join(" | "),
			);
		}
	}

	console.log("\n=== aggregate ===");
	for (const arm of ["A", "B", "C", "D"] as Arm[]) {
		const armRecords = records.filter(record => record.arm === arm);
		const classes = armRecords.map(record => classify(record.opening, record.markers));
		const minimal = classes.filter(value => value === "minimal-like").length;
		const standard = classes.filter(value => value === "standard-like").length;
		const ambiguous = classes.filter(value => value === "ambiguous").length;
		const markerSum = armRecords.reduce(
			(a, record) => ({
				we: a.we + record.markers.we,
				weNeed: a.weNeed + record.markers.weNeed,
				lets: a.lets + record.markers.lets,
				letMe: a.letMe + record.markers.letMe,
			}),
			{ we: 0, weNeed: 0, lets: 0, letMe: 0 },
		);
		console.log(
			`${arm}: minimal-like=${minimal}/${reps} standard-like=${standard}/${reps} ambiguous=${ambiguous}/${reps} | markers ${JSON.stringify(markerSum)}`,
		);
	}
	console.log(`records=${join(root, "records.json")}`);
}

await main();
