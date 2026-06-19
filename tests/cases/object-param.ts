// Objects across the function boundary: built and returned by value (RVO), and
// accepted as a param by const&. Field reads work on both a named object and a
// temporary returned from another call.
function makePoint(x: number, y: number): { x: number; y: number } {
  return { x: x, y: y };
}

function dist2(p: { x: number; y: number }): number {
  return p.x * p.x + p.y * p.y;
}

let p = makePoint(3, 4);
console.log(p.x);
console.log(p.y);
console.log(dist2(p));
console.log(dist2(makePoint(6, 8)));
