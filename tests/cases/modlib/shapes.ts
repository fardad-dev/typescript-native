// Namespace-imported as a whole by ../module-namespace.ts: exposes a function, a
// constant, and a class — exercising `ns.fn(...)`, `ns.CONST`, `new ns.Cls(...)`,
// and the qualified type name `ns.Cls`.
export function area(w: number, h: number): number {
  return w * h;
}

export const UNIT = "px";

export class Box {
  size: number;
  constructor(size: number) {
    this.size = size;
  }
  doubled(): number {
    return this.size * 2;
  }
}
