// Map: set (with overwrite), get, has, delete, size, and JS-style printing.
const m = new Map<string, number>();
m.set("a", 1);
m.set("b", 2);
m.set("a", 10); // overwrite keeps insertion position
console.log(m.size);
console.log(m.get("a"));
console.log(m.get("b"));
console.log(m.has("a"));
console.log(m.has("z"));
console.log(m.delete("a"));
console.log(m.has("a"));
console.log(m.size);
console.log(m);
