// End-to-end integer workload (the benchmark shape): trial-division primes.
function isPrime(n: number): boolean {
  if (n < 2) { return false; }
  if (n % 2 === 0) { return n === 2; }
  let j: number = 3;
  while (j * j <= n) { if (n % j === 0) { return false; } j = j + 2; }
  return true;
}
let count: number = 0;
let i: number = 2;
while (i <= 50) { if (isPrime(i)) { count = count + 1; } i = i + 1; }
console.log(count);
