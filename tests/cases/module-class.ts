// Importing a class from another module: construct it, read a field, call a method.
import { Point } from "./modlib/point";

let p = new Point(3, 4);
console.log(p.sum());
console.log(p.x);
