// A function may read and write a module-level (top-level) variable: it is
// promoted to a file-scope global so a separately-compiled function body can see
// it. `counter` is an integer global (i64 rep); `label` is a string global.
let counter = 0;
let label = "n";

function bump(): number {
  counter = counter + 1;
  return counter;
}

function tagged(): string {
  return label + counter;
}

console.log(bump()); // 1
console.log(bump()); // 2
console.log(tagged()); // n2
console.log(counter); // 2
