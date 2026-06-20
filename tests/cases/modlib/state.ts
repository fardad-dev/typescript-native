// A dependency module: `internal` is private (not exported), `shared` is exported.
// Both are module variables (record fields); `reveal` reads both. The importer can
// read `shared` but not `internal` (the stage-0 checker enforces that), yet this
// module's own function reaches both — the module-record model.
let internal = "secret";
export let shared = "public";

export function reveal(): string {
  return internal + "/" + shared;
}
