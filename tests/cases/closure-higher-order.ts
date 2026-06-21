// User-defined higher-order functions: a function-typed parameter.
function apply(f: (x: number) => number, x: number): number {
  return f(x);
}
function twice(f: (x: number) => number, x: number): number {
  return f(f(x));
}
const inc = (n: number): number => n + 1;
console.log(apply(inc, 10));
console.log(twice(inc, 10));
console.log(apply((n: number): number => n * n, 5));
