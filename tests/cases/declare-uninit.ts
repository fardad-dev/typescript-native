// Variables declared without an initializer: the annotation supplies the type
// (the subset has no `any` to infer from), and the variable is assigned before
// it is read (TS stage 0 enforces "used before assigned").
let a: string;
a = "hi";
console.log(a);

// Assigned on every path of a branch, then read.
let n: number;
if (a.length > 0) {
  n = a.length;
} else {
  n = 0;
}
console.log(n);

// i64 rep: declared uninit, only ever assigned integers -> long long.
let i: number;
i = 5;
i = i + 1;
console.log(i);

// f64 rep: a fraction reaches it -> double (the rep pass must see the later assign).
let f: number;
f = 7 / 2;
console.log(f);

// A reference-type slot declared uninit, then assigned.
let xs: number[];
xs = [1, 2, 3];
console.log(xs.length);

// A class field declared without an initializer (assigned in the constructor) —
// the existing, only supported field form.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
const p = new Point(3, 4);
console.log(p.x + p.y);
