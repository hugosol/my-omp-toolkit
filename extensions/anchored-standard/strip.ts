/**
 * Persona-section stripping for the captured omp prompt.
 *
 * The omp template wraps the persona between the "§ Role" and "§ Runtime"
 * markers: everything before the role marker (system conventions) and from
 * the runtime marker on (skills/rules, internal URLs, tool inventory, xd://
 * device docs, project block) is kept; the persona section in between is
 * dropped. Missing or reversed markers leave a block untouched — the caller
 * decides whether anything was stripped and can disable the extension.
 */

export const ROLE_MARKER = "§ Role";
export const RUNTIME_MARKER = "§ Runtime";

/** True when the block carries both markers in the required order. */
export function hasPersonaSections(block: string): boolean {
	const roleAt = block.indexOf(ROLE_MARKER);
	const runtimeAt = block.indexOf(RUNTIME_MARKER);
	return roleAt !== -1 && runtimeAt > roleAt;
}

/** Strip the persona section of one prompt block; missing markers leave it unchanged. */
export function stripPersonaSections(block: string): string {
	if (!hasPersonaSections(block)) return block;
	const roleAt = block.indexOf(ROLE_MARKER);
	const runtimeAt = block.indexOf(RUNTIME_MARKER);
	return block.slice(0, roleAt) + block.slice(runtimeAt);
}

export interface StripResult {
	/** Stripped blocks joined with the same separator used for appends. */
	content: string;
	/** True when at least one block carried the persona markers and was stripped. */
	stripped: boolean;
}

/** Strip every captured prompt block; blocks without markers pass through unchanged. */
export function stripCapturedPrompt(blocks: readonly string[]): StripResult {
	let stripped = false;
	const content = blocks
		.map(block => {
			if (hasPersonaSections(block)) {
				stripped = true;
				return stripPersonaSections(block);
			}
			return block;
		})
		.join("\n\n");
	return { content, stripped };
}
