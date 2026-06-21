// A top-level function used as a first-class value (passed to another function).
function square(n: number): number {
  return n * n;
}
function applyTo(f: (x: number) => number, xs: number[]): number[] {
  const out: number[] = [];
  for (const x of xs) {
    out.push(f(x));
  }
  return out;
}
console.log(applyTo(square, [1, 2, 3, 4]));
