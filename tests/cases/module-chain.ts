// Transitive imports: the entry imports `mid`, which imports `base`. All three
// modules are resolved, lowered, and merged in dependency order.
import { mid } from "./modlib/mid";

console.log(mid());
