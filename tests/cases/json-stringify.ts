// JSON.stringify: scalars (numbers/bools/strings with escapes), arrays, objects
// (nested), arrays of objects, class instances, and empties. Matches Node's
// JSON.stringify byte-for-byte (compact, double-quoted keys, no spaces).
console.log(JSON.stringify(42));
console.log(JSON.stringify(3.5));
console.log(JSON.stringify(true));
console.log(JSON.stringify("hi"));
console.log(JSON.stringify("quote \" backslash \\ newline \n tab \t"));
console.log(JSON.stringify([1, 2, 3]));
console.log(JSON.stringify(["a", "b"]));
let obj = { x: 1, y: 2, name: "p" };
console.log(JSON.stringify(obj));
let nested = { id: 1, tags: ["a", "b"], pos: { x: 3, y: 4 } };
console.log(JSON.stringify(nested));
let aos = [{ id: 1 }, { id: 2 }];
console.log(JSON.stringify(aos));
let empty: number[] = [];
console.log(JSON.stringify(empty));

class Pt {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
console.log(JSON.stringify(new Pt(5, 6)));
