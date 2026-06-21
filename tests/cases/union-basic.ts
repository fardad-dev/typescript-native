// Union types: a union-typed parameter (where TS keeps the full union), widening
// a member into a union slot, printing, JSON.stringify, and equality vs a member.

// Inside `show`, `x` keeps the full `number | string` type (no narrowing), so it
// prints either member, serializes, and compares against a member of either type.
function show(x: number | string): void {
  console.log(x);
  console.log(JSON.stringify(x));
  console.log(x === "two");
  console.log(x === 5);
}
show(1);
show("two");
show(5);

// A `T | null` union compared against `null` (the canonical first member).
function isNull(v: string | null): boolean {
  return v === null;
}
console.log(isNull(null));
console.log(isNull("x"));

// Top-level: declare a union, widen a member in, reassign the other member, print.
let a: number | string = 1;
console.log(a);
a = "two";
console.log(a);

let n: string | null = null;
console.log(n);
n = "set";
console.log(n);
