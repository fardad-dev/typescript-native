// Regression: integer-valued variables divided must yield JS float division,
// not C++ integer division. (Two `int`-repr vars previously emitted `int/int`.)
const a = 12;
const b = 5;
console.log(a / b);
let x: number = 10;
let y: number = 4;
console.log(x / y);
console.log(10 / 2);
