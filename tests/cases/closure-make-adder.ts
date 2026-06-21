// A function that returns a closure capturing a (read-only) parameter.
function makeAdder(n: number): (x: number) => number {
  return (x: number): number => x + n;
}
const add5 = makeAdder(5);
const add10 = makeAdder(10);
console.log(add5(1));
console.log(add10(1));
console.log(add5(100));
