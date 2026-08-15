/**
 * Project2 V4.1b A/B orchestrator for anchored-standard.
 *
 * Replicates the dsh-anchored-standard use case on this machine:
 *
 *   for arm in anchored|control, run 1..N:
 *     1. `python evaluator/make_broken_project.py`  — reset the broken seed
 *     2. spawn `omp --print` in `modeltest/workspace` with CANDIDATE_PROMPT.md
 *        as the initial message (anchored arm = anchored-standard + wire probe,
 *        control arm = wire probe only; both via --trusted-extension allowlist)
 *     3. `python evaluator/run_full_eval.py workspace/project2_task …` — hidden
 *        tests + frozen scoring produce ability_draft / ship_draft / blockers
 *     4. record transcript markers, wire payloads, and scores per run
 *
 * ESP-IDF build (--include-espidf-build) is NOT run: no ESP-IDF toolchain on
 * this machine. The ESP-IDF static contract tests do run as part of full eval.
 *
 * Usage:
 *   bun tests/anchored-standard/bench-project2.ts --runs 5
 *   bun tests/anchored-standard/bench-project2.ts --runs 1 --arm anchored
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	parseSession,
	parseWireRequests,
	PROBE_SOURCE,
	type RequestStats,
	type WireRequest,
} from "./bench-anchor-style";
import { eArmSource } from "./matrix-anchor-style";

const MODELTEST_ROOT = process.env.MODELTEST_ROOT ?? "E:/Developer/myhub/dsh/modeltest";
const WORKSPACE = join(MODELTEST_ROOT, "workspace");
const CANDIDATE_PROMPT = join(MODELTEST_ROOT, "CANDIDATE_PROMPT.md");
const EXT_ENTRY = join(import.meta.dir, "..", "..", "extensions", "anchored-standard", "index.ts");

/** The candidate prompt is the fenced body under "提示词正文"; the file's
 * header/metadata must not reach the model (dsh protocol pastes the body only). */
function candidatePrompt(): string {
	const text = readFileSync(CANDIDATE_PROMPT, "utf8");
	const match = text.match(/```text\r?\n([\s\S]*?)```/);
	if (!match) {
		throw new Error(`candidate prompt fenced body not found in ${CANDIDATE_PROMPT}`);
	}
	return match[1].trim();
}

const DEFAULT_RUNS = 5;
const MODEL = process.env.BENCH_MODEL ?? "deepseek/deepseek-v4-pro";
const THINKING = "max";
const MODEL_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const EVAL_TIMEOUT_MS = 30 * 60 * 1000;

type Arm = "anchored" | "control" | "e";

interface RunRecord {
	arm: Arm;
	run: number;
	exitCode: number | null;
	durationMs: number;
	abilityDraft: number | null;
	shipDraft: number | null;
	releaseClass: string | null;
	blockers: unknown;
	sessionFile?: string;
	requests: RequestStats[];
	wireRequests: WireRequest[];
	runDir: string;
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function parseArgs(argv: string[]) {
	const runsRaw = flag(argv, "runs");
	const runs = runsRaw === undefined ? DEFAULT_RUNS : Number.parseInt(runsRaw, 10);
	if (!Number.isSafeInteger(runs) || runs < 1) {
		throw new Error(`--runs must be a positive integer, got ${JSON.stringify(runsRaw)}`);
	}
	const armRaw = flag(argv, "arm");
	const arm: Arm | undefined = armRaw === "anchored" || armRaw === "control" || armRaw === "e" ? armRaw : undefined;
	if (armRaw !== undefined && arm === undefined) {
		throw new Error(`--arm must be anchored, control, or e; got ${JSON.stringify(armRaw)}`);
	}
	const armsRaw = flag(argv, "arms");
	const arms: Arm[] = armsRaw
		? armsRaw
				.split(",")
				.map(value => value.trim())
				.filter(value => value.length > 0)
				.map(value => {
					if (value !== "anchored" && value !== "control" && value !== "e") {
						throw new Error(`--arms may only contain anchored, control, e; got ${JSON.stringify(value)}`);
					}
					return value;
				})
		: [];
	if (arms.length === 0 && arm !== undefined) {
		arms.push(arm);
	}
	const timeoutRaw = flag(argv, "timeout");
	const timeoutMs = timeoutRaw === undefined ? MODEL_TIMEOUT_MS : Number.parseInt(timeoutRaw, 10) * 1000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`--timeout must be positive seconds, got ${JSON.stringify(timeoutRaw)}`);
	}
	const skip = new Set(
		(flag(argv, "skip") ?? "")
			.split(",")
			.map(value => value.trim())
			.filter(value => value.length > 0),
	);
	return { runs, arms, timeoutMs, skip, include: flag(argv, "include") };
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

async function runPython(args: string[], cwd: string, logPath: string, timeoutMs: number): Promise<{ exitCode: number; text: string }> {
	const proc = Bun.spawn({
		cmd: ["python", ...args],
		cwd,
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
	}, timeoutMs);
	const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
	const exitCode = await proc.exited;
	clearTimeout(killer);
	const text = stdout + (stderr.length > 0 ? `\n[stderr]\n${stderr}` : "");
	writeFileSync(logPath, text);
	return { exitCode, text };
}

async function resetProject(runDir: string): Promise<void> {
	console.log("[reset] make_broken_project.py");
	const result = await runPython(
		["evaluator/make_broken_project.py"],
		MODELTEST_ROOT,
		join(runDir, "reset.log"),
		EVAL_TIMEOUT_MS,
	);
	if (result.exitCode !== 0) {
		throw new Error(`make_broken_project exited ${result.exitCode}\n${result.text.slice(-2000)}`);
	}
}

async function runModel(
	arm: Arm,
	armEntries: string[],
	runDir: string,
	sessionDir: string,
	probeEntry: string,
	timeoutMs: number,
): Promise<{
	exitCode: number | null;
	durationMs: number;
}> {
	const extensionFlags = [...armEntries, probeEntry].flatMap(entry => ["--trusted-extension", entry]);
	const prompt = candidatePrompt();
	// Multi-line argv is truncated by the omp.cmd shim; @file is the omp-native
	// full-content path (processFileArguments reads the whole file).
	const promptPath = join(runDir, "candidate-prompt.md");
	writeFileSync(promptPath, prompt);
	const cmdArgs = [
		Bun.which("omp") ?? "omp",
		"--print",
		"--print-thoughts",
		"--session-dir",
		sessionDir,
		"--model",
		MODEL,
		"--thinking",
		THINKING,
		"--no-title",
		"--auto-approve",
		...extensionFlags,
		`@${promptPath}`,
	];
	console.log(`[model] ${arm}: ${cmdArgs.slice(0, 8).join(" ")} …`);
	const start = Date.now();
	const proc = Bun.spawn({
		cmd: cmdArgs,
		cwd: WORKSPACE,
		stdout: Bun.file(join(runDir, "omp-stdout.log")),
		stderr: Bun.file(join(runDir, "omp-stderr.log")),
		env: Bun.env,
	});
	const killer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}, timeoutMs);
	const exitCode = await proc.exited;
	clearTimeout(killer);
	return { exitCode, durationMs: Date.now() - start };
}

interface EvalScores {
	abilityDraft: number | null;
	shipDraft: number | null;
	releaseClass: string | null;
	blockers: unknown;
}

async function runEval(arm: Arm, runIndex: number, runDir: string): Promise<EvalScores> {
	console.log("[eval] run_full_eval.py");
	const harnessNames: Record<Arm, string> = {
		anchored: "omp-anchored-standard",
		control: "omp-control",
		e: "omp-e-persona-anchor",
	};
	const harness = harnessNames[arm];
	const result = await runPython(
		[
			"evaluator/run_full_eval.py",
			"workspace/project2_task",
			"--model",
			"deepseek-v4-pro",
			"--channel",
			"deepseek",
			"--harness",
			harness,
			"--require-meta",
			"--run-group-id",
			`omp_v4pro_max_${arm}`,
			"--run-index",
			String(runIndex),
			"--thinking-level",
			THINKING,
		],
		MODELTEST_ROOT,
		join(runDir, "eval.log"),
		EVAL_TIMEOUT_MS,
	);
	const output = result.text;
	// Nonzero eval steps are expected while the candidate still fails tests;
	// the frozen scorer prints the draft line regardless, so parse it and let
	// the caller record failures via summary files.
	const abilityMatch = output.match(/ability=([0-9.]+)/);
	const shipMatch = output.match(/ship=([0-9.]+)/);
	const classMatch = output.match(/class=([A-Z][0-9A-Za-z-]*)/);
	const blockersMatch = output.match(/blockers=(\[[^\n]*)/);
	let blockers: unknown = null;
	if (blockersMatch) {
		try {
			blockers = JSON.parse(blockersMatch[1].replace(/'/g, '"'));
		} catch {
			blockers = blockersMatch[1];
		}
	}
	return {
		abilityDraft: abilityMatch ? Number.parseFloat(abilityMatch[1]) : null,
		shipDraft: shipMatch ? Number.parseFloat(shipMatch[1]) : null,
		releaseClass: classMatch ? classMatch[1] : null,
		blockers,
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const arms: Arm[] = args.arms.length > 0 ? args.arms : ["anchored", "control"];
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const root = join(import.meta.dir, "project2-runs", timestamp);
	mkdirSync(root, { recursive: true });

	const probeDir = join(tmpdir(), `anchor-style-probe-${Date.now()}`);
	mkdirSync(probeDir, { recursive: true });
	const probeEntry = join(probeDir, "probe.ts");
	writeFileSync(probeEntry, PROBE_SOURCE);

	const armEntries: Record<Arm, string[]> = {
		anchored: [EXT_ENTRY],
		control: [],
		e: [],
	};
	if (arms.includes("e")) {
		const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "extensions", "anchored-standard", "config.json"), "utf8")) as {
			personaText: string;
		};
		const eEntry = join(probeDir, "e-arm.ts");
		writeFileSync(eEntry, eArmSource(config.personaText));
		armEntries.e = [eEntry];
	}

	console.log(`model=${MODEL} thinking=${THINKING} arms=${arms.join(",")} runs=${args.runs}`);
	console.log(`modeltest=${MODELTEST_ROOT}`);
	console.log(`results=${root}`);

	const records: RunRecord[] = args.include
		? (JSON.parse(readFileSync(args.include, "utf8")) as RunRecord[])
		: [];
	for (const arm of arms) {
		for (let run = 1; run <= args.runs; run += 1) {
			if (args.skip.has(`${arm}-${run}`)) {
				console.log(`[skip] ${arm}-${run}`);
				continue;
			}
			const runDir = join(root, `${arm}-${run}`);
			const sessionDir = join(runDir, "session");
			mkdirSync(runDir, { recursive: true });
			mkdirSync(sessionDir, { recursive: true });
			console.log(`\n=== ${arm} ${run}/${args.runs} ===`);

			await resetProject(runDir);
			const { exitCode, durationMs } = await runModel(
				arm,
				armEntries[arm],
				runDir,
				sessionDir,
				probeEntry,
				args.timeoutMs,
			);

			const sessionFile = newestJsonl(sessionDir);
			const requests = sessionFile ? parseSession(sessionFile) : [];
			const stderrText = readFileSync(join(runDir, "omp-stderr.log"), "utf8");
			const wireRequests = parseWireRequests(stderrText);

			let scores: EvalScores = {
				abilityDraft: null,
				shipDraft: null,
				releaseClass: null,
				blockers: null,
			};
			try {
				scores = await runEval(arm, run, runDir);
			} catch (error) {
				console.error(`[eval] failed: ${String((error as Error)?.message ?? error)}`);
			}

			const record: RunRecord = {
				arm,
				run,
				exitCode,
				durationMs,
				...scores,
				sessionFile,
				requests,
				wireRequests,
				runDir,
			};
			records.push(record);
			writeFileSync(join(root, "records.json"), JSON.stringify(records, null, 2));
			console.log(
				[
					`RESULT ${arm} run=${run}`,
					`exit=${exitCode}`,
					`dur=${(durationMs / 60000).toFixed(1)}m`,
					`ability=${scores.abilityDraft ?? "?"}`,
					`ship=${scores.shipDraft ?? "?"}`,
					`class=${scores.releaseClass ?? "?"}`,
					`wire#1=${wireRequests[0] ? `${wireRequests[0].tools.join("+")}/${wireRequests[0].maxTokens}` : "missing"}`,
				].join(" | "),
			);
		}
	}

	console.log("\n=== summary ===");
	for (const arm of arms) {
		const armRecords = records.filter(record => record.arm === arm);
		const abilities = armRecords.map(record => record.abilityDraft).filter((value): value is number => value !== null);
		const mean = abilities.length > 0 ? abilities.reduce((sum, value) => sum + value, 0) / abilities.length : Number.NaN;
		console.log(`${arm}: n=${armRecords.length} ability=${abilities.join(",")} mean=${mean.toFixed(2)}`);
	}
	console.log(`records=${join(root, "records.json")}`);
}

await main();
