// Anonymous function expressions, and calling a call's result: make(3)(4).
const make = function (n: number): (x: number) => number {
  return function (x: number): number {
    return x + n;
  };
};
console.log(make(3)(4));
console.log(make(10)(5));
