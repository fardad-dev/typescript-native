// Object field that is itself an object: { label: string; inner: { x: number; y: number } }.
let box: { label: string; inner: { x: number; y: number } } = {
  label: "p",
  inner: { x: 10, y: 20 },
};
console.log(box.label);
console.log(box.inner.x);
console.log(box.inner.y);
box.inner.x = 99;
console.log(box.inner.x);
