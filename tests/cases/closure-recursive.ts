// A self-referential closure stored in a function-local const (captured by its own
// body ⇒ boxed; the two-step emission lets it reference itself).
function run(): number {
  const fib: (n: number) => number = (n: number): number => {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
  };
  return fib(10);
}
console.log(run());
