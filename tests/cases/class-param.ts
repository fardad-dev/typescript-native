// Class instances cross function boundaries by reference: a callee's mutation is
// visible to the caller, and a function can construct and return an instance.
class Vec {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

function scale(v: Vec, k: number): void {
  v.x = v.x * k;
  v.y = v.y * k;
}

function origin(): Vec {
  return new Vec(0, 0);
}

let v = new Vec(2, 3);
scale(v, 4);
console.log(v.x);
console.log(v.y);

let o = origin();
console.log(o.x);
console.log(o.y);
