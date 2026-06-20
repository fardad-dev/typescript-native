// Middle of the chain: imports a sibling module (relative to this file's folder)
// and is itself imported by ../module-chain.ts.
import { base } from "./base";

export function mid(): number {
  return base() + 10;
}
