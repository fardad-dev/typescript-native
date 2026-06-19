// Lift the scalar-only boundary: arrays as function params (read-only, by
// const&) and as return values (by value, via RVO/move). A returned array can
// be passed straight into another function — the temporary binds to the const&.
function sum(xs: number[]): number {
  let total: number = 0;
  let i: number = 0;
  while (i < xs.length) {
    total = total + xs[i];
    i = i + 1;
  }
  return total;
}

function makeRange(n: number): number[] {
  let xs: number[] = [];
  let i: number = 0;
  while (i < n) {
    xs.push(i);
    i = i + 1;
  }
  return xs;
}

let r: number[] = makeRange(5);
console.log(r.length);
console.log(sum(r));
console.log(sum(makeRange(4)));
