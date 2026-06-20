// The module-record model end to end: a dependency module wraps its top-level in
// a memoized init returning a record of its variables. The importer reads an
// exported variable (`shared`) and calls a function that reads both the exported
// and the private variable.
import { shared, reveal } from "./modlib/state";

console.log(shared); // public
console.log(reveal()); // secret/public
