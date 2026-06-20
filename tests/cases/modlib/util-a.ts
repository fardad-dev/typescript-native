// util-a and util-b each define a top-level function `val` (a name collision)
// and a public function that calls `val`. Each module's caller must resolve to
// its OWN `val` after the colliding names are mangled apart.
export function val(): number {
  return 1;
}

export function getA(): number {
  return val();
}
