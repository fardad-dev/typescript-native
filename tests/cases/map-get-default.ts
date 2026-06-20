// Subset divergence (documented): the subset has no `undefined`, so Map.get of a
// MISSING key returns the value type's default (0 for number) rather than
// `undefined`. The `!` non-null assertion lets get() of a present key type-check.
const counts = new Map<string, number>();
counts.set("x", 5);
const x: number = counts.get("x")!;
console.log(x + 1);
console.log(counts.get("missing"));
