// A method that mutates `this`; the mutation persists across calls and loops.
class Counter {
  count: number;
  constructor() {
    this.count = 0;
  }
  inc(): void {
    this.count = this.count + 1;
  }
  add(n: number): void {
    this.count = this.count + n;
  }
}

let c = new Counter();
c.inc();
c.inc();
console.log(c.count);
for (let i = 0; i < 5; i++) {
  c.add(10);
}
console.log(c.count);
