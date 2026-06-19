let p: { x: number; y: number } = { x: 1, y: 2 };
p.x = 100;
p.y = p.y + 1;
console.log(p.x);
console.log(p.y);
