// Non-number fields: a string field, plus a method that builds a string from
// `this.field` and calls a string method on it.
class Greeter {
  name: string;
  times: number;
  constructor(name: string, times: number) {
    this.name = name;
    this.times = times;
  }
  greet(): string {
    return "Hello, " + this.name + "!";
  }
  shout(): string {
    return this.name.toUpperCase();
  }
}

let g = new Greeter("ada", 3);
console.log(g.greet());
console.log(g.shout());
console.log(g.times);
