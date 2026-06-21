// A default export that is a plain expression (not a declaration) — lowered to a
// synthetic module variable — plus a named export, so the importer can use the
// `import dflt, { named }` form. Imported by ../module-default.ts.
export default 20;

export function note(): string {
  return "noted";
}
