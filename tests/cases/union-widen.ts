// A narrower union widens into a wider one: `number | string` flows into a
// `number | string | null` slot (the C++ variant is rebuilt around the active
// member). Covers both a function return and a `let` initializer.
function widen(x: number | string): number | string | null {
  return x;
}
console.log(widen(5));
console.log(widen("hi"));

let v: number | string = 9;
let w: number | string | null = v;
console.log(w);
v = "now a string";
let w2: number | string | null = v;
console.log(w2);
