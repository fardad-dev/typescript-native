// Top-level `await` in the entry module (the `import` makes this a module, which
// is what TypeScript requires for top-level await). The whole top-level runs as a
// coroutine: `await` in a `let` initializer, in a sequence, and inside a loop body.
import { asyncAdd, asyncDouble } from "./modlib/asyncmath";

console.log("start");
const a = await asyncDouble(10);
const b = await asyncAdd(a, 5);
console.log(a);
console.log(b);

let total = 0;
for (const n of [1, 2, 3]) {
  total = total + (await asyncDouble(n));
}
console.log(total);
console.log("end");
