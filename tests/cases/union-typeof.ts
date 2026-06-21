// `typeof` as a value: on a union it's resolved at runtime (the active member);
// on any other expression it's the statically-known type string. Note the JS
// quirk `typeof null === "object"`.
function t(x: number | string | null): string {
  return typeof x;
}
console.log(t(5));
console.log(t("hi"));
console.log(t(null));

let n = 42;
console.log(typeof n);
console.log(typeof "s");
console.log(typeof true);
