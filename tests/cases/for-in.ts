// `for (const k in target)` — iterate the *keys* (always strings): array indices
// "0".."n-1", or an object/instance's field names.
let arr = [100, 200, 300];
for (const i in arr) {
  console.log(i); // "0", "1", "2" (top-level strings print bare)
}

let point = { x: 1, y: 2, z: 3 };
for (const k in point) {
  console.log(k); // x, y, z (declaration order)
}

// keys can be accumulated like any string
let joined = "";
for (const k in point) {
  joined = joined + k;
}
console.log(joined); // xyz
