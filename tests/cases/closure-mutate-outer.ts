// A closure observes a mutation made to a captured local AFTER it was created.
function demo(): number {
  let x = 1;
  const get = (): number => x;
  x = 99;
  return get();
}
console.log(demo());
