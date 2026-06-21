// Import aliasing: bind exported names under different local names.
import { add as plus, mul as times } from "./modlib/math";

console.log(plus(2, 3));
console.log(times(4, 5));
