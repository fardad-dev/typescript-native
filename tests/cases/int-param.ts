// Integer values flow through function params and returns; a `/` in the body
// makes the return float even when called with an integer argument.
function sq(n: number): number { return n * n; }
function half(n: number): number { return n / 2; }
console.log(sq(5));
console.log(half(5));
console.log(sq(sq(3)));
