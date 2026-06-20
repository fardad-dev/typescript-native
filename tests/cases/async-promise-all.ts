// `await Promise.all([...])` — resolves to an array of every result, in order.
async function sq(n: number): Promise<number> {
  return n * n;
}

async function run(): Promise<void> {
  const xs = await Promise.all([sq(1), sq(2), sq(3), sq(4)]);
  console.log(xs);
  let s = 0;
  for (const v of xs) s = s + v;
  console.log(s);
}

run();
