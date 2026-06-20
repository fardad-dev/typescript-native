// `for (const x of iterable)` — iterate an array's elements or a string's chars.
let xs = [10, 20, 30];
let total = 0;
for (const x of xs) {
  total = total + x;
}
console.log(total); // 60

// element type is inferred from the array (here: string)
const words = ["a", "bb", "ccc"];
for (const w of words) {
  console.log(w.length); // 1, 2, 3
}

// iterating a string yields one-character strings
let reversed = "";
for (const ch of "hello") {
  reversed = ch + reversed;
}
console.log(reversed); // olleh
