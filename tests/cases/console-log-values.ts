// Richer console.log: booleans as true/false; arrays/objects printed JS-style
// (single-quoted strings when nested, recursive for nested aggregates).
console.log(true);
console.log(false);
console.log(1 < 2);
let nums: number[] = [1, 2, 3];
console.log(nums);
let strs: string[] = ["a", "b", "c"];
console.log(strs);
let p = { x: 1, y: 2, label: "p" };
console.log(p);
let grid: number[][] = [[1, 2], [3, 4]];
console.log(grid);
let aos: { id: number; tag: string }[] = [{ id: 1, tag: "a" }, { id: 2, tag: "b" }];
console.log(aos);
let empty: number[] = [];
console.log(empty);
