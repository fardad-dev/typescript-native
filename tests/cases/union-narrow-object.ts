// Narrowing a union down to a single *reference* member (an object type) via
// `typeof v === "object"`: the object member is extracted (std::get) so its field
// is accessible; the else-branch narrows to the string member.
function f(v: string | { x: number }): number {
  if (typeof v === "object") {
    return v.x;
  }
  return v.length;
}
console.log(f({ x: 9 }));
console.log(f("hello"));

// Narrowing a class member out of a union.
class Box {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}
function unwrap(b: Box | number): number {
  if (typeof b === "number") {
    return b;
  }
  return b.v;
}
console.log(unwrap(7));
console.log(unwrap(new Box(42)));
