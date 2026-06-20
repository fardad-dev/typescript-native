// Round-trip: parse JSON into a typed value, mutate / transform it, serialize
// back. Exercises parse and stringify together on the same shapes.
let data = JSON.parse("{\"items\": [1, 2], \"total\": 3}") as {
  items: number[];
  total: number;
};
data.items.push(3);
data.total = 6;
console.log(JSON.stringify(data));

let words = JSON.parse("[\"b\", \"a\", \"c\"]") as string[];
console.log(words.join("-"));
console.log(JSON.stringify(words));
