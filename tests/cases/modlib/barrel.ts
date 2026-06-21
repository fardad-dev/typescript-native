// A barrel module: re-exports names from sibling modules without importing them
// locally. `export { a as b } from` renames a single re-export; `export *`
// re-exports all of another module's exports. Imported by ../module-reexport.ts.
export { add as sum } from "./math";
export * from "./config";
