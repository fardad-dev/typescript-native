// Object field that is an array: { name: string; pts: number[] }.
let poly: { name: string; pts: number[] } = { name: "tri", pts: [3, 1, 2] };
console.log(poly.name);
console.log(poly.pts.length);
console.log(poly.pts[0]);
poly.pts[0] = 9;
console.log(poly.pts[0]);
poly.pts.push(4);
console.log(poly.pts.length);
console.log(poly.pts[3]);
