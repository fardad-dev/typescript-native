// An array of function values, called by index.
const ops: ((a: number, b: number) => number)[] = [
  (a: number, b: number): number => a + b,
  (a: number, b: number): number => a - b,
  (a: number, b: number): number => a * b,
];
console.log(ops[0](6, 4));
console.log(ops[1](6, 4));
console.log(ops[2](6, 4));
