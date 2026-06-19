// Array of objects: { x: number; y: number }[] — index, field access, mutate, push.
let pts: { x: number; y: number }[] = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
console.log(pts.length);
console.log(pts[0].x);
console.log(pts[1].y);
pts[0].x = 50;
console.log(pts[0].x);
pts.push({ x: 5, y: 6 });
console.log(pts[2].x);
