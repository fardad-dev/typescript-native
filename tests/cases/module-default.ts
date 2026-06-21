// Default imports: a default-exported function (with a named sibling), and a
// default-exported expression imported together with a named export in one
// `import dflt, { named }` statement.
import square, { LABEL } from "./modlib/defaultfn";
import answer, { note } from "./modlib/defaultval";

console.log(square(5));
console.log(LABEL);
console.log(answer);
console.log(note());
