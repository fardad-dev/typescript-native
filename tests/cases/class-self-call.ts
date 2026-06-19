// A method calling another method on `this`, and a class instance field that
// references a class declared later (forward-declaration path).
class Account {
  rate: Rate;
  balance: number;
  constructor(balance: number, rate: Rate) {
    this.balance = balance;
    this.rate = rate;
  }
  interest(): number {
    return this.balance * this.rate.percent();
  }
  grow(): void {
    this.balance = this.balance + this.interest();
  }
}

class Rate {
  bps: number;
  constructor(bps: number) {
    this.bps = bps;
  }
  percent(): number {
    return this.bps / 10000;
  }
}

let acc = new Account(1000, new Rate(500));
console.log(acc.interest());
acc.grow();
console.log(acc.balance);
