// A helper module exporting top-level constants — imported by ../module-const.ts.
// In the merged program these initialize (in dependency order) before the entry's
// top-level code, so the importer sees their values.
export const LIMIT = 10;
export const NAME = "tsn";
