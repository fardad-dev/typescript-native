// Soundness: a variable seeded with an integer but later assigned a fractional
// value must be represented as float (no truncation to 2).
let x: number = 10;
x = x / 4;
console.log(x);
