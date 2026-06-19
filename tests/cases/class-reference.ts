// Reference semantics: two variables alias the same instance, so a mutation
// through one is visible through the other (unlike value-typed object literals).
class Box {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

let a = new Box(1);
let b = a;
b.v = 10;
console.log(a.v);
a.v = 42;
console.log(b.v);

let c = new Box(1);
console.log(c.v);
