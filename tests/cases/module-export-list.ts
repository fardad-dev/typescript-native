// Importing from a module that exports via a trailing `export { ... }` list
// (including a rename, `two as TWO`).
import { one, TWO } from "./modlib/listexports";

console.log(one());
console.log(TWO);
