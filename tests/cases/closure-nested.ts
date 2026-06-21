// Nested closures: each level captures a variable from an outer scope.
function adder(a: number): (b: number) => (c: number) => number {
  return (b: number): (c: number) => number => {
    return (c: number): number => a + b + c;
  };
}
console.log(adder(1)(2)(3));
console.log(adder(10)(20)(30));
