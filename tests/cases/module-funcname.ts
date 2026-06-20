// Cross-module function-name scoping: util-a and util-b both define `val`, and
// each module's getX calls its own `val`. Verifies intra-module references
// resolve to the right (mangled) function after the collision is scoped apart.
import { getA } from "./modlib/util-a";
import { getB } from "./modlib/util-b";

console.log(getA()); // 1
console.log(getB()); // 2
