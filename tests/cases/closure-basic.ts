// Arrow functions stored in variables and called directly.
const double = (x: number): number => x * 2;
console.log(double(21));

const greet = (name: string): string => "hi " + name;
console.log(greet("sam"));

// Block-bodied arrow.
const clamp = (x: number): number => {
  if (x < 0) return 0;
  if (x > 10) return 10;
  return x;
};
console.log(clamp(-3));
console.log(clamp(5));
console.log(clamp(42));
