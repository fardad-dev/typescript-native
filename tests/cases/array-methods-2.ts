// Broader Array.prototype methods: includes, lastIndexOf, reverse, fill, concat,
// shift, unshift. Reference semantics: reverse/fill mutate in place and return
// the same array; concat returns a new one.
const nums = [1, 2, 3, 2, 1];
console.log(nums.includes(3));
console.log(nums.includes(9));
console.log(nums.lastIndexOf(2));

const words = ["a", "b", "c"];
console.log(words.includes("b"));
words.reverse();
console.log(words);

const grid = [0, 0, 0, 0];
grid.fill(7, 1, 3);
console.log(grid);

const left = [1, 2];
const right = [3, 4];
console.log(left.concat(right));
console.log(left); // concat does not mutate

const q = [10, 20, 30];
console.log(q.shift());
console.log(q);
console.log(q.unshift(5, 8));
console.log(q);
