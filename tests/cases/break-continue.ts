// `break` exits the innermost loop; `continue` skips to its next iteration.
let sum = 0;
for (let i = 0; i < 10; i = i + 1) {
  if (i === 5) {
    break;
  }
  sum = sum + i; // 0 + 1 + 2 + 3 + 4
}
console.log(sum); // 10

let evens = 0;
for (let i = 0; i < 10; i = i + 1) {
  if (i % 2 === 1) {
    continue;
  }
  evens = evens + 1; // i = 0, 2, 4, 6, 8
}
console.log(evens); // 5

// `break` / `continue` in a while loop.
let i = 0;
let collected = 0;
while (i < 100) {
  i = i + 1;
  if (i > 4) {
    break;
  }
  collected = collected + i; // 1 + 2 + 3 + 4
}
console.log(collected); // 10
