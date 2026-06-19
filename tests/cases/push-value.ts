let xs: number[] = [1, 2];
let n = xs.push(3); // returns the new length, 3
console.log(n); // 3
console.log(xs.push(4)); // 4
console.log(xs.length); // 4
console.log(xs[3]); // 4

let words: string[] = [];
console.log(words.push("a")); // 1
console.log(words.push("b")); // 2
console.log(words.join(",")); // a,b
