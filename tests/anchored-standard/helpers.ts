/**
 * Shared test helpers: minimal Bun surface declaration (the toolkit tsconfig
 * carries no bun types) and temp-file management.
 */

declare const Bun: {
	file(path: string): { exists(): Promise<boolean>; text(): Promise<string>; delete(): Promise<void> };
	write(path: string, content: string): Promise<number>;
};

// bun-only: import.meta.dir is the module's directory.
const moduleDir = (import.meta as unknown as { dir?: string }).dir ?? ".";

export function tempFilePath(label: string): string {
	return `${moduleDir}/${label}-${crypto.randomUUID()}.json`;
}

export async function writeTextFile(path: string, content: string): Promise<void> {
	await Bun.write(path, content);
}

export async function readTextFile(path: string): Promise<string> {
	return Bun.file(path).text();
}

export async function removeFile(path: string): Promise<void> {
	await Bun.file(path).delete();
}
