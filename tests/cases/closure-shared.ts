// Two closures sharing one mutable local variable (needs real capture, not
// by-value copies): deposit() mutates `total`, balance() reads it.
function makeBank(): { deposit: (n: number) => void; balance: () => number } {
  let total = 0;
  const deposit = (n: number): void => {
    total = total + n;
  };
  const balance = (): number => total;
  return { deposit: deposit, balance: balance };
}
const bank = makeBank();
bank.deposit(100);
bank.deposit(50);
console.log(bank.balance());
bank.deposit(25);
console.log(bank.balance());
