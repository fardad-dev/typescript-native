// Cross-module scoping: red.ts and blue.ts each have a top-level `const color`
// (a name collision) read by their own function. The two `color` globals are
// scoped per module, so each function returns its own module's value.
import { red } from "./modlib/red";
import { blue } from "./modlib/blue";

console.log(red()); // red
console.log(blue()); // blue
