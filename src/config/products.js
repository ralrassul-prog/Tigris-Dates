const products = [
  {
    id: "mix-5lb",
    name: "5lb Mix Dates Box",
    weightLabel: "5lb",
    typeLabel: "Mix",
    priceCents: 2500,
    imageUrl: ""
  },
  {
    id: "jumbo-5lb",
    name: "5lb Jumbo Dates Box",
    weightLabel: "5lb",
    typeLabel: "Jumbo",
    priceCents: 3000,
    imageUrl: ""
  },
  {
    id: "mix-10lb",
    name: "10lb Mix Dates Box",
    weightLabel: "10lb",
    typeLabel: "Mix",
    priceCents: 5000,
    imageUrl: ""
  },
  {
    id: "jumbo-10lb",
    name: "10lb Jumbo Dates Box",
    weightLabel: "10lb",
    typeLabel: "Jumbo",
    priceCents: 6000,
    imageUrl: ""
  },
  {
    id: "honey-1lb",
    name: "Honey 1lb",
    weightLabel: "1lb",
    typeLabel: "Honey",
    priceCents: 1000,
    imageUrl: ""
  },
  {
    id: "chocolate-dates-12pc",
    name: "Chocolate Covered Dates (12 pieces)",
    weightLabel: "12 pieces",
    typeLabel: "Chocolate Covered",
    priceCents: 2000,
    imageUrl: ""
  },
  {
    id: "chocolate-dates-24pc",
    name: "Chocolate Covered Dates (24 pieces)",
    weightLabel: "24 pieces",
    typeLabel: "Chocolate Covered",
    priceCents: 4000,
    imageUrl: ""
  }
];

function getProductById(productId) {
  return products.find((product) => product.id === productId);
}

module.exports = {
  products,
  getProductById
};
