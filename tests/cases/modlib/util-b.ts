// See modlib/util-a.ts — its `val` collides with util-a's by name but is a
// distinct function; getB must call this module's `val`, not util-a's.
export function val(): number {
  return 2;
}

export function getB(): number {
  return val();
}
