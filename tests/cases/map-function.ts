// Map as a function return type + local; ternary with get()!; for…of over a
// string building a frequency map.
function countChars(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of s) {
    const cur = counts.has(ch) ? counts.get(ch)! : 0;
    counts.set(ch, cur + 1);
  }
  return counts;
}

const result = countChars("banana");
console.log(result.get("b")!);
console.log(result.get("a")!);
console.log(result.get("n")!);
console.log(result.size);
