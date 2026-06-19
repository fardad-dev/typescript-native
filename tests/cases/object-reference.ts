// Objects are reference types: alias + shared mutation + identity `===`, and a
// function can mutate an object parameter (visible to the caller) — JS semantics.
function bump(p: { n: number }): void {
  p.n = p.n + 1;
}
let p = { n: 1 };
let q = p;
q.n = 10;
console.log(p.n);
console.log(p === q);
let r = { n: 10 };
console.log(p === r);
bump(p);
console.log(p.n);
