// Default parameters: resolved at the function's entry, may reference earlier
// params, and the param has its declared (non-undefined) type in the body.
function greet(name: string, greeting: string = "Hello"): string {
  return greeting + ", " + name;
}
function rangeSum(start: number, end: number = start + 3): number {
  let total = 0;
  for (let i = start; i <= end; i++) total += i;
  return total;
}
console.log(greet("Ada"));
console.log(greet("Ada", "Hi"));
console.log(rangeSum(1));        // 1+2+3+4 = 10
console.log(rangeSum(1, 2));     // 1+2 = 3

// Default on a closure (function value) — `f()` uses the default.
const scale = (x: number, factor: number = 2): number => x * factor;
console.log(scale(5));
console.log(scale(5, 10));

// Default of a reference type.
function withTags(name: string, tags: string[] = ["none"]): string {
  return name + "[" + tags.join(",") + "]";
}
console.log(withTags("x"));
console.log(withTags("y", ["a", "b"]));
