// `switch` matches with `===`, supports `default`, and `break` exits early.
function describe(n: number): string {
  switch (n) {
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      return "many";
  }
}
console.log(describe(1)); // one
console.log(describe(2)); // two
console.log(describe(9)); // many

// fall-through: clauses without `break` fall into the next one.
function steps(n: number): number {
  let c = 0;
  switch (n) {
    case 3:
      c = c + 1;
    case 2:
      c = c + 1;
    case 1:
      c = c + 1;
  }
  return c;
}
console.log(steps(3)); // 3
console.log(steps(1)); // 1

// string discriminant + break.
let color = "green";
let code = 0;
switch (color) {
  case "red":
    code = 1;
    break;
  case "green":
    code = 2;
    break;
  default:
    code = -1;
}
console.log(code); // 2
