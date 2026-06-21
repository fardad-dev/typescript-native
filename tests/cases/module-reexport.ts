// Importing names that a barrel module re-exports from other modules: a renamed
// named re-export (`add as sum`) and an `export *` star re-export (LIMIT, NAME).
import { sum, LIMIT, NAME } from "./modlib/barrel";

console.log(sum(2, 3));
console.log(LIMIT);
console.log(NAME);
