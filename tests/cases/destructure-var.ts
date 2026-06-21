// Array & object destructuring in let/const declarations: rename, holes, rest,
// defaults (array length-based), and nesting. The source is evaluated once.
function pair(): number[] {
  return [10, 20, 30, 40];
}
const [first, second, ...others] = pair();
console.log(first);          // 10
console.log(second);         // 20
console.log(others.join(",")); // 30,40

const [, b, , d] = pair();   // holes
console.log(b);              // 20
console.log(d);              // 40

const [x, y, z = 99] = [1, 2]; // z defaulted (out of bounds)
console.log(x + y + z);      // 102

const point = { px: 3, py: 4, label: "P" };
const { px, py, label: name } = point;  // rename label -> name
console.log(px);             // 3
console.log(py);             // 4
console.log(name);           // P

const nested = { outer: { inner: 7 }, items: [1, 2, 3] };
const { outer: { inner }, items: [head] } = nested;  // nested patterns
console.log(inner);          // 7
console.log(head);           // 1

const matrix = [[1, 2], [3, 4]];
const [[a0, a1], [b0]] = matrix;
console.log(a0 + a1 + b0);   // 6
