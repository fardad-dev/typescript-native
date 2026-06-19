// Arrays are reference types: `let b = a` aliases the same array, a mutation
// through one is visible through the other, and a function can mutate an array
// parameter (visible to the caller) — JS semantics.
function pushTwice(xs: number[]): void {
  xs.push(99);
  xs.push(100);
}
let a: number[] = [1, 2, 3];
let b = a;
b.push(4);
console.log(a.length);
console.log(a[3]);
a[0] = 50;
console.log(b[0]);
pushTwice(a);
console.log(a.length);
console.log(a[5]);
