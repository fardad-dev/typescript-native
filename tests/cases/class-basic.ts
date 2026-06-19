// A class with fields, a constructor, and a method; new + field read + method call.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  manhattan(): number {
    return this.x + this.y;
  }
}

let p = new Point(3, 4);
console.log(p.x);
console.log(p.y);
console.log(p.manhattan());
