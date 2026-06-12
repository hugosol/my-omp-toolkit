/**
 * File Lock Extension — 编辑后必须重新 read 的硬守卫。
 * 两层防护：
 *   1. 锁：read 授予编辑权 → edit 消费锁 → 再次 edit 被阻止
 *      write 不受锁守卫限制（不依赖行号），但成功后仍标记 edited: true
 *   2. Tag 校验（仅 hashline）：编辑中使用的 tag 必须与最近一次 read 的 tag 一致
 *
 * 默认关闭，通过 /lock 命令切换。开启后状态栏显示 "🔒 hardcore edit"。
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";

// ============================================================================
// 状态
// ============================================================================

let enabled = false;

interface FileEntry {
	/** 最近一次 read 获得的 snapshot tag */
	tag: string;
	/** read 之后是否被编辑过 */
	edited: boolean;
}

const fileState = new Map<string, FileEntry>();

// ============================================================================
// 路径辅助
// ============================================================================

function toAbsolute(inputPath: string, cwd: string): string {
	if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
	return path.resolve(cwd, inputPath);
}

// ============================================================================
// Hashline 头解析
// ============================================================================

const HASHLINE_HEADER_RE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]/m;

interface HashlineHeader {
	relativePath: string;
	tag: string;
}

function parseHashlineHeader(text: string): HashlineHeader | null {
	const match = text.match(HASHLINE_HEADER_RE);
	if (!match) return null;
	return { relativePath: match[1], tag: match[2] };
}

// ============================================================================
// 从 tool_call input 提取编辑目标文件路径
// ============================================================================

interface InputLike {
	path?: unknown;
	input?: unknown;
	paths?: unknown;
}

function extractEditPaths(input: InputLike, toolName: string): string[] {
	// hashline: 从 input 字符串的头解析路径
	if (toolName === "edit" && typeof input.input === "string") {
		const header = parseHashlineHeader(input.input);
		if (header) return [header.relativePath];
	}

	// replace / patch / write: input.path
	if (typeof input.path === "string") return [input.path];

	// ast_edit: input.paths
	if (Array.isArray(input.paths)) {
		return input.paths.filter((p): p is string => typeof p === "string");
	}

	return [];
}

// ============================================================================
// 从 read tool_result 提取 tag
// ============================================================================

interface ResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: {
		resolvedPath?: string;
		meta?: { source?: { type?: string; value?: string } };
	};
}

function extractReadTag(result: ResultLike): { absolutePath: string; tag: string } | null {
	const resolvedPath = result.details?.meta?.source?.value ?? result.details?.resolvedPath;
	if (typeof resolvedPath !== "string") return null;
	const textContent = result.content?.find(c => c.type === "text");
	if (!textContent?.text) return null;

	const header = parseHashlineHeader(textContent.text);
	if (!header) return null;

	return { absolutePath: resolvedPath, tag: header.tag };
}

// ============================================================================
// 状态栏
// ============================================================================

const STATUS_KEY = "filelock";
const STATUS_TEXT = "🔒 hardcore edit";

function updateStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, enabled ? STATUS_TEXT : undefined);
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function fileLock(pi: ExtensionAPI): void {
	pi.setLabel("File Lock");

	// ── 会话启动：初始化状态栏 ──
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	// ── /lock 命令 ──
	pi.registerCommand("lock", {
		description: "切换文件锁：开启后编辑过的文件必须重新 read 才能再编辑",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			fileState.clear();
			updateStatus(ctx);
			ctx.ui.setWorkingMessage(`文件锁已${enabled ? "开启 🔒" : "关闭"}`);
		},
	});

	// ═══════════════════════════════════════════════════════════════
	// tool_call: 编辑/写入前置守卫
	// ═══════════════════════════════════════════════════════════════

	const editTools = new Set(["edit", "write"]);

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;

		const toolName = event.toolName;

		// write 不使用 hashline 行号定位，无需读取前置守卫
		// 但成功的 write 仍通过 tool_result 标记 edited: true（防后续 hashline 编辑的陈旧行号）
		if (toolName === "write") return;

		if (!editTools.has(toolName)) return;

		const input = event.input as Record<string, unknown>;
		const rawPaths = extractEditPaths(input, toolName);

		if (rawPaths.length === 0) return;

		const absolutePaths = rawPaths.map(p => toAbsolute(p, ctx.cwd));

		for (const absPath of absolutePaths) {
			const entry = fileState.get(absPath);

			// ① 文件未被读过
			if (!entry) {
				return {
					block: true,
					reason: `文件 ${path.relative(ctx.cwd, absPath)} 未被读取，请先使用 read 工具读取文件内容。`,
				};
			}

			// ② read 之后被编辑过，锁已消费
			if (entry.edited) {
				return {
					block: true,
					reason: `文件 ${path.relative(ctx.cwd, absPath)} 已被修改，请重新 read 获取最新内容和行号，然后重新计算编辑位置。`,
				};
			}

			// ③ hashline 模式：检查 tag 是否匹配最近一次 read 的 tag
			if (toolName === "edit" && typeof input.input === "string") {
				const header = parseHashlineHeader(input.input);
				if (header && header.tag !== entry.tag) {
					return {
						block: true,
						reason: `文件 ${path.relative(ctx.cwd, absPath)} 的 tag 已过期（使用了 ${header.tag}，最新为 ${entry.tag}），请使用最近一次 read 输出中的 tag。`,
					};
				}
			}
		}
	});

	// ═══════════════════════════════════════════════════════════════
	// tool_result: read — 记录 tag + 清除编辑标记
	// ═══════════════════════════════════════════════════════════════

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;

		if (event.toolName !== "read") return;

		const result = event as ResultLike;
		const extracted = extractReadTag(result);
		if (!extracted) return;

		fileState.set(extracted.absolutePath, {
			tag: extracted.tag,
			edited: false,
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// tool_result: edit/write/ast_edit — 上锁
	// ═══════════════════════════════════════════════════════════════

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;

		const toolName = event.toolName;
		if (!editTools.has(toolName)) return;

		// 编辑失败不上锁
		if (event.isError) return;

		const input = event.input as Record<string, unknown>;
		const rawPaths = extractEditPaths(input, toolName);

		for (const p of rawPaths) {
			const absPath = toAbsolute(p, ctx.cwd);
			const entry = fileState.get(absPath);
			if (entry) {
				fileState.set(absPath, { tag: entry.tag, edited: true });
			}
		}
	});
}
