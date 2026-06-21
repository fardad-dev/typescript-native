// console.log of a function value, bare and nested in an array.
const f = (x: number): number => x * 2;
console.log(f);
const fns: ((x: number) => number)[] = [f, f];
console.log(fns);
