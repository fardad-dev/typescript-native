// An async function returns a value; an async caller awaits it.
async function answer(): Promise<number> {
  return 42;
}

async function main(): Promise<void> {
  const a = await answer();
  console.log(a);
}

main();
