// Capturing a for-of loop variable: each iteration binds a fresh `i`, so the
// closures return 0, 1, 2 (JS `let` per-iteration semantics).
const fns: (() => number)[] = [];
for (const i of [0, 1, 2]) {
  fns.push((): number => i * 10);
}
console.log(fns[0]());
console.log(fns[1]());
console.log(fns[2]());
