// A closure capturing and MUTATING a local; each counter is independent and
// its state persists across calls.
function makeCounter(): () => number {
  let count = 0;
  return (): number => {
    count = count + 1;
    return count;
  };
}
const c = makeCounter();
console.log(c());
console.log(c());
console.log(c());
const d = makeCounter();
console.log(d());
console.log(c());
