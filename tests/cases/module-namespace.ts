// Namespace import: reach an exported function, constant, and class constructor
// through the `S` namespace object, plus a namespace-qualified type name (S.Box).
import * as S from "./modlib/shapes";

console.log(S.area(3, 4));
console.log(S.UNIT);
let b: S.Box = new S.Box(5);
console.log(b.doubled());
