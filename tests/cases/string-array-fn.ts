// string[] across the boundary: a param (const&) read by index, and a return
// value built with push, then reassembled with join.
function firstWord(words: string[]): string {
  return words[0];
}

function repeat(w: string, n: number): string[] {
  let xs: string[] = [];
  let i: number = 0;
  while (i < n) {
    xs.push(w);
    i = i + 1;
  }
  return xs;
}

let ws: string[] = repeat("hi", 3);
console.log(ws.length);
console.log(firstWord(ws));
console.log(ws.join(", "));
