// Destructuring parameters on functions, methods, and closures: array & object
// patterns, rename, nesting, and combined with a default param.
function dist({ x, y }: { x: number; y: number }): number {
  return x * x + y * y;
}
console.log(dist({ x: 3, y: 4 })); // 25

function firstTwo([a, b]: number[]): number {
  return a * 10 + b;
}
console.log(firstTwo([7, 8, 9])); // 78

// Object param with rename + nested object.
function describe({ name: label, loc: { city } }: { name: string; loc: { city: string } }): string {
  return label + "@" + city;
}
console.log(describe({ name: "Ada", loc: { city: "London" } })); // Ada@London

// Destructured param with a whole-param default.
function area({ w, h }: { w: number; h: number } = { w: 1, h: 1 }): number {
  return w * h;
}
console.log(area());              // 1
console.log(area({ w: 3, h: 5 })); // 15

// Closure with a destructured parameter.
const sumPair = ([a, b]: number[]): number => a + b;
console.log(sumPair([2, 40])); // 42

class Vec {
  x: number;
  y: number;
  constructor({ x, y }: { x: number; y: number }) {
    this.x = x;
    this.y = y;
  }
  add([dx, dy]: number[]): number {
    return this.x + this.y + dx + dy;
  }
}
const v = new Vec({ x: 1, y: 2 });
console.log(v.add([3, 4])); // 10
