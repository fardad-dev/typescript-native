// JS `||` / `&&` return one of their operands (not a coerced boolean): `||`
// yields the first truthy operand, `&&` the first falsy one. The operands must
// share a type (no union result in the subset); both-boolean keeps the classic
// boolean result. Truthiness is JS-style (0/NaN/"" are falsy). (Variables are
// used throughout: `strict` TS flags `||`/`&&` on literal constants as
// always-truthy/falsy.)
function pick(param: string): string {
  return param || "fallback";
}

console.log(pick("hi")); // hi
console.log(pick("")); // fallback

let a = 0;
let b = 5;
console.log(a || b); // 5

let c = 3;
let d = 9;
console.log(c || d); // 3

let empty = "";
let x = "x";
console.log(empty && x); // (empty line)

let aa = "a";
let bb = "b";
console.log(aa && bb); // b

let t = true;
let f = false;
console.log(t || f); // true
console.log(t && f); // false
