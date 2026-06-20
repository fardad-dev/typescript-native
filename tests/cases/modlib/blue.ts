// See modlib/red.ts — same shape, different value. Its top-level `const color`
// collides with red.ts's by name but is a distinct, per-module global.
const color = "blue";

export function blue(): string {
  return color;
}
