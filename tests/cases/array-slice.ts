let xs: number[] = [1, 2, 3, 4, 5];

let a = xs.slice(1, 3); // [2, 3]
console.log(a.length); // 2
console.log(a[0]); // 2
console.log(a[1]); // 3

let b = xs.slice(2); // [3, 4, 5]
console.log(b.length); // 3
console.log(b[0]); // 3

let c = xs.slice(-2); // [4, 5]
console.log(c.length); // 2
console.log(c[0]); // 4

let d = xs.slice(); // full copy
console.log(d.length); // 5

console.log(xs.length); // 5 — slice does not mutate

let words: string[] = ["x", "y", "z"];
let e = words.slice(1); // ["y", "z"]
console.log(e[0]); // y
console.log(e.length); // 2
