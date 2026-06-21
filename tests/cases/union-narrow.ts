// Flow narrowing: a union variable used as one of its members inside a `typeof` /
// `=== null` / truthiness guard (the then- and else-branches narrow oppositely).

// `typeof x === "string"` narrows x to string in the then-branch (so `.length`
// and `+` work) and to number in the else-branch (so `* 2` works).
function describe(x: number | string): string {
  if (typeof x === "string") {
    return "str:" + x + ":" + x.length;
  } else {
    return "num:" + x * 2;
  }
}
console.log(describe("hello"));
console.log(describe(21));

// Narrowing through a ternary's two branches.
function kind(v: number | string): string {
  return typeof v === "number" ? "" + (v + 100) : v.toUpperCase();
}
console.log(kind(5));
console.log(kind("hi"));

// `=== null` narrows the else-branch to the non-null member.
function len(s: string | null): number {
  if (s === null) {
    return -1;
  }
  return s.length;
}
console.log(len(null));
console.log(len("abcd"));

// A boolean `&&` chain narrows the same variable twice (then-branch is string).
function trim2(s: number | string): string {
  if (typeof s === "string" && s.length > 2) {
    return s.substring(0, 2);
  }
  return "short";
}
console.log(trim2("hello"));
console.log(trim2("ab"));
console.log(trim2(99));
