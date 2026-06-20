// Set: construct from an array (dedupes), add (chained), has, delete, size,
// for…of iteration, and JS-style printing.
const s = new Set<number>([1, 2, 3, 2, 1]);
console.log(s.size);
console.log(s.has(2));
console.log(s.has(9));
s.add(4);
s.add(2); // duplicate — no-op
console.log(s.size);
console.log(s.delete(1));
console.log(s.has(1));
let sum = 0;
for (const x of s) {
  sum += x;
}
console.log(sum);
console.log(s);

const tags = new Set<string>();
tags.add("x").add("y").add("x");
console.log(tags.size);
console.log(tags);
