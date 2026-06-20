// A dependency's top-level code runs before the entry's: "module loaded" (from
// the imported module) prints before "hello" (from this file).
import { greet } from "./modlib/greet";

const main = "hello";

console.log(greet(main));
