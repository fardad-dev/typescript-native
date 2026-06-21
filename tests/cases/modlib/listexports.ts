// A module that exports via a trailing `export { name, name as alias }` list
// instead of an `export` modifier on each declaration. Imported by
// ../module-export-list.ts.
function one(): number {
  return 1;
}
const two = 2;

export { one, two as TWO };
