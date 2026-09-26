/** Bun imports `.md` files as text via `with { type: "text" }`. */
declare module "*.md" {
	const text: string;
	export default text;
}
