// console.log of class instances: `Name { field: value, ... }`, recursively
// inside arrays.
class Pt {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
let pt = new Pt(3, 4);
console.log(pt);
let arr: Pt[] = [new Pt(1, 1), new Pt(2, 2)];
console.log(arr);
