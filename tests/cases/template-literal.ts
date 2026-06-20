// Template-literal interpolation: `` `a${x}b` `` desugars to string
// concatenation (head + expr + literal + ...), reusing the `+`-concatenation
// path — so an interpolated value coerces exactly the way `+` does (string and
// number operands). The head (possibly empty) anchors the whole chain to
// `string`, so a lone `${x}` of a number is still a string.

const name = "world";
const count = 3;

// head + interp + tail, mixing string and number interpolation
console.log(`Hello, ${name}! You have ${count} messages.`);

// leading interpolation (empty head) and trailing interpolation (empty tail)
console.log(`${count} items`);
console.log(`name is ${name}`);

// a lone interpolation — still a string, even though count is a number
console.log(`${count}`);

// adjacent interpolations (empty middle quasi)
const a = 1;
const b = 2;
console.log(`${a}${b}`);

// an interpolated expression (arithmetic stays numeric, then coerces)
console.log(`sum = ${a + b}`);

// interpolation inside a function, fed an expression
function greet(who: string, n: number): string {
  return `Hi ${who}, #${n}`;
}
console.log(greet("Sam", count + 1));
