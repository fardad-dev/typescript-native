// An array of class instances (std::vector<std::shared_ptr<T>>): push, index,
// method calls on elements, and mutation through an indexed element.
class Item {
  price: number;
  constructor(price: number) {
    this.price = price;
  }
  withTax(): number {
    return this.price + this.price / 10;
  }
}

let cart: Item[] = [new Item(100), new Item(200)];
cart.push(new Item(50));
console.log(cart.length);
console.log(cart[2].price);
console.log(cart[0].withTax());
cart[1].price = 999;
console.log(cart[1].price);
