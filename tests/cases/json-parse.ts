// JSON.parse with a static target type, supplied via `as T` or a variable
// annotation. The parser tolerates whitespace and arbitrary key order; the typed
// value is then usable like any other (arithmetic, indexing, field access, log).
let n = JSON.parse("42") as number;
console.log(n + 1);

let b = JSON.parse("true") as boolean;
console.log(b);

let s = JSON.parse("\"hello\"") as string;
console.log(s);
console.log(s.length);

let arr = JSON.parse("[1, 2, 3]") as number[];
console.log(arr);
console.log(arr[0] + arr[1] + arr[2]);

// Annotation form, with keys out of order in the source text.
let obj: { x: number; y: number } = JSON.parse("{ \"y\": 20, \"x\": 10 }");
console.log(obj.x + obj.y);
console.log(obj);

// Nested: an array of objects inside an object.
let deep = JSON.parse("{\"id\": 1, \"pts\": [{\"v\": 7}, {\"v\": 8}]}") as {
  id: number;
  pts: { v: number }[];
};
console.log(deep.id);
console.log(deep.pts[1].v);
console.log(deep);
