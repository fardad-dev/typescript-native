// `default` need not be last: it runs only when no case matched, but once entered
// it falls through into the clauses that follow it (JS semantics).
function f(n: number): string {
  let out = "";
  switch (n) {
    case 1:
      out = out + "a";
      break;
    default:
      out = out + "d";
    case 2:
      out = out + "b";
      break;
  }
  return out;
}
console.log(f(1)); // a
console.log(f(2)); // b
console.log(f(9)); // d then falls into case 2 -> "db"
