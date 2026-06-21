// A class with a function-VALUED field: set in the constructor, called via the
// instance (`b.transform(x)`) and via `this.transform(x)` in a method.
class Box {
  transform: (x: number) => number;
  constructor(t: (x: number) => number) {
    this.transform = t;
  }
  apply(x: number): number {
    return this.transform(x);
  }
}
const b = new Box((n: number): number => n * 3);
console.log(b.apply(5));
console.log(b.transform(10));
