// A module with top-level code (a side effect). When imported, its top-level
// statements run once, in dependency order — before the importer's — so this
// prints before ../module-sideeffect.ts's own output.
console.log("module loaded");
const main = "fall back";

export function greet(param: string): string {
  return param || main;
}
