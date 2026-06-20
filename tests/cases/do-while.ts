// `do { ... } while (cond)` — the body runs once before the condition is tested.
let i = 5;
do {
  console.log(i);
  i = i + 1;
} while (i < 3); // condition false on entry, so the body runs exactly once

let sum = 0;
let n = 1;
do {
  sum = sum + n;
  n = n + 1;
} while (n <= 3); // 1 + 2 + 3
console.log(sum);
