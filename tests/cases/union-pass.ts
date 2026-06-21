// Reordered unions are the SAME type: `f`'s param `string | number` and the
// variable `v: number | string` canonicalize identically, so `f(v)` type-checks
// and `f`'s `number | string` return is the same C++ `tsn_union` too.
function f(x: string | number): number | string {
  return x;
}
let v: number | string = "hi";
console.log(f(v));
console.log(f(7));

// `number | boolean` — exercises the `std::in_place_type` disambiguation, since a
// `std::variant<double, bool>` is otherwise ambiguous to construct from an int.
function tag(b: number | boolean): string {
  return JSON.stringify(b);
}
console.log(tag(true));
console.log(tag(3));
console.log(tag(false));
