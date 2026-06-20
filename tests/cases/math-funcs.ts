// Exponential / logarithmic / trigonometric functions with exact integer results.
console.log(Math.exp(0));
console.log(Math.log(1));
console.log(Math.log2(8));
console.log(Math.sin(0));
console.log(Math.cos(0));
console.log(Math.atan2(0, 1));
console.log(Math.max(-1, -5));
console.log(Math.pow(3, 3));

// A small loop using Math in a number context (i64 args coerce to double).
let total = 0;
for (let i = 1; i <= 4; i++) {
  total += Math.floor(i * 1.5);
}
console.log(total);
