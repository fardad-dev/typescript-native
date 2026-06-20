// Math.random() returns a number in [0, 1). The exact value isn't deterministic
// across implementations, so assert the range invariant instead.
const r = Math.random();
console.log(r >= 0 && r < 1);
