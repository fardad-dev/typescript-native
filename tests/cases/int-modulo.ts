// Integer modulo uses the fast integer path; a fractional operand still falls
// back to fmod semantics. Division by a runtime-zero must not be UB.
let a: number = 17;
let b: number = 5;
console.log(a % b);
console.log(5.5 % 2);
let z: number = 0;
console.log(a % z);
