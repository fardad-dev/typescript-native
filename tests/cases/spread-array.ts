// Spread elements in array literals: copy, concat, and mix with plain elements.
const a: number[] = [1, 2, 3];
const b: number[] = [4, 5];
const copy = [...a];
copy.push(99);
console.log(a.length); // 3 — spread made a fresh copy
console.log(copy.length); // 4
const joined = [0, ...a, ...b, 6];
console.log(joined.join(","));
const words = ["a", "b"];
const more = [...words, "c"];
console.log(more.join("-"));
