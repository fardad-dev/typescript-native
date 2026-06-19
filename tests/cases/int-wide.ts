// Integer numbers use 64-bit representation: a product past 2^31 stays exact
// (would overflow a 32-bit int) and prints without a trailing ".0".
let m: number = 1000000;
let p: number = m * m;
console.log(p);
console.log(p + 1);
