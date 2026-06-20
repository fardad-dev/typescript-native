// Awaiting async functions imported from another module (the loader/renamer must
// rewrite the imported references and their Promise<T> types across modules).
import { asyncAdd, asyncDouble } from "./modlib/asyncmath";

async function run(): Promise<void> {
  const s = await asyncAdd(3, 4);
  const d = await asyncDouble(s);
  console.log(s);
  console.log(d);
}

run();
