// Rest parameters: collect trailing args into a fresh array; call directly and
// via spread.
function sum(...xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}
function tag(label: string, ...rest: number[]): string {
  return label + ":" + rest.length + ":" + sum(...rest);
}
console.log(sum());
console.log(sum(1, 2, 3));
const nums = [4, 5, 6, 7];
console.log(sum(...nums));
console.log(sum(1, ...nums, 100));
console.log(tag("a", 10, 20));
console.log(tag("b"));
