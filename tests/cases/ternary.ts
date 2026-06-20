// Ternary `cond ? a : b` — a conditional expression. The two branches must
// share a type (the subset has no union result), and that's the result type;
// the condition must be a number or boolean (matching `if`/`while`). The result
// representation follows the branches: both integer-valued -> i64, else f64.
// (Variables are used in the conditions: `strict` TS flags a literal-constant
// condition as always-true/false.)
function classify(n: number): string {
  // nested ternary: `a ? b : (c ? d : e)`
  return n < 0 ? "negative" : n === 0 ? "zero" : "positive";
}

console.log(classify(-3)); // negative
console.log(classify(0)); // zero
console.log(classify(7)); // positive

let age = 20;
let label = age >= 18 ? "adult" : "minor";
console.log(label); // adult

// numeric result, both branches integer-valued -> stays i64
let x = 5;
let y = x > 3 ? 100 : 200;
console.log(y); // 100

// the ternary feeds arithmetic; a fractional operand forces f64
let z = (x > 0 ? 1 : 2) + 0.5;
console.log(z); // 1.5

// a boolean-typed condition (from a variable)
let ok = true;
console.log(ok ? "yes" : "no"); // yes
