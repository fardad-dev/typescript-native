// Array of arrays: number[][] — construct, index, mutate, push a row.
let grid: number[][] = [[1, 2, 3], [4, 5, 6]];
console.log(grid.length);
console.log(grid[0].length);
console.log(grid[1][2]);
grid[0][0] = 100;
console.log(grid[0][0]);
let row: number[] = [7, 8];
grid.push(row);
console.log(grid[2][1]);
