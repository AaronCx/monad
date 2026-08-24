/**
 * Markdown files imported with `with { type: "text" }` resolve to their
 * contents as a string (Bun's text loader, bundled into compiled binaries).
 */
declare module "*.md" {
  const text: string;
  export default text;
}
