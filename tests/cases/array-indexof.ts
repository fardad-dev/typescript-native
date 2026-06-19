let xs: number[] = [10, 20, 30, 20];
console.log(xs.indexOf(20)); // 1
console.log(xs.indexOf(30)); // 2
console.log(xs.indexOf(99)); // -1
console.log(xs.indexOf(20, 2)); // 3 — search from index 2
console.log(xs.indexOf(10, -1)); // -1 — search from the last index

let words: string[] = ["ada", "alan", "grace"];
console.log(words.indexOf("alan")); // 1
console.log(words.indexOf("zara")); // -1
