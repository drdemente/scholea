// Allow importing Markdown files as raw strings (Vite ?raw) — used to bundle the
// in-app User Guide from docs/USER_GUIDE.md as the single source of truth.
declare module "*.md?raw" {
  const content: string;
  export default content;
}
