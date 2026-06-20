// An async class method — same coroutine treatment as an async free function.
// `this.field` mutation through the awaited method is visible to the caller.
class Account {
  balance: number;
  constructor(b: number) {
    this.balance = b;
  }
  async deposit(amount: number): Promise<number> {
    this.balance = this.balance + amount;
    return this.balance;
  }
}

async function run(): Promise<void> {
  const acct = new Account(100);
  console.log(await acct.deposit(50));
  console.log(await acct.deposit(25));
}

run();
