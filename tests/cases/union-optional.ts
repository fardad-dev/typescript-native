// Optional parameters (`a?: T`) desugar to `T | undefined`: a caller may omit a
// trailing optional (it becomes `undefined`), and `=== undefined` narrows it.
function greet(name: string, greeting?: string): string {
  if (greeting === undefined) {
    return "Hello, " + name;
  }
  return greeting + ", " + name;
}
console.log(greet("Ada"));
console.log(greet("Ada", "Hi"));

// An optional used inside a ternary guard.
function inc(x: number, by?: number): number {
  return x + (by === undefined ? 1 : by);
}
console.log(inc(10));
console.log(inc(10, 5));

// `=== null` early-return narrowing on a `T | null` parameter.
function label(s: string | null): string {
  if (s === null) {
    return "none";
  }
  return s;
}
console.log(label(null));
console.log(label("named"));
