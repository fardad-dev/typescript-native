// Labeled loops let `break`/`continue` target an *outer* loop.
let found = "";
outer: for (let i = 0; i < 3; i = i + 1) {
  for (let j = 0; j < 3; j = j + 1) {
    if (i + j === 3) {
      found = i + "," + j;
      break outer; // break out of BOTH loops
    }
  }
}
console.log(found); // first pair with i + j === 3 -> "1,2"

// labeled `continue` restarts the outer loop.
let total = 0;
rows: for (let r = 0; r < 3; r = r + 1) {
  for (let c = 0; c < 3; c = c + 1) {
    if (c === r) {
      continue rows; // skip the rest of this row
    }
    total = total + 1;
  }
}
console.log(total); // 3

// a do-while can be labeled too.
let k = 0;
search: do {
  for (let m = 0; m < 5; m = m + 1) {
    k = k + 1;
    if (m === 2) {
      break search;
    }
  }
} while (k < 100);
console.log(k); // 3
