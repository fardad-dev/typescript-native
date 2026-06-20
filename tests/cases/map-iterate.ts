// Map: chained .set, iterate .keys() / .values() with for…of, number keys.
const scores = new Map<string, number>();
scores.set("alice", 90).set("bob", 85).set("carol", 95);
for (const name of scores.keys()) {
  console.log(name);
}
let total = 0;
for (const v of scores.values()) {
  total += v;
}
console.log(total);
console.log(scores.size);

const byId = new Map<number, string>();
byId.set(1, "one");
byId.set(2, "two");
console.log(byId.get(1)!);
console.log(byId);
