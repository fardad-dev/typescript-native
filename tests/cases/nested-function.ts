// Nested aggregates across function boundaries: an array-of-objects param
// (passed by const&) and a number[][] returned by value.
function totalX(pts: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum = sum + pts[i].x;
  }
  return sum;
}

function makeGrid(n: number): number[][] {
  let g: number[][] = [];
  for (let i = 0; i < n; i++) {
    let row: number[] = [];
    row.push(i);
    row.push(i * i);
    g.push(row);
  }
  return g;
}

let pts: { x: number; y: number }[] = [{ x: 1, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 0 }];
console.log(totalX(pts));

let g: number[][] = makeGrid(4);
console.log(g.length);
console.log(g[3][0]);
console.log(g[3][1]);
