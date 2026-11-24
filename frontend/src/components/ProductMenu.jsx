import { PickMenu } from "./PickMenu.jsx";

export const OTHER = "Other";

// The office's Other product, where receipt lines that fit no product go.
export function otherProduct(products) {
  return products.find((product) => product.name.trim().toLowerCase() === OTHER.toLowerCase());
}

// `withOther` offers Other (an empty value) when the office has no Other
// product yet. Receipt review uses it: Other is added when the purchases are.
export function ProductMenu({ products, value, onChange, label = "Product", withOther = false }) {
  const options = products.map((product) => ({ value: product.productId, label: product.name }));
  return (
    <PickMenu
      options={withOther && !otherProduct(products) ? [...options, { value: "", label: OTHER, detail: "Added to this office with these purchases" }] : options}
      value={value}
      onChange={onChange}
      label={label}
      placeholder="Choose a product"
      searchLabel="Search products"
      emptyText="No product matches that search."
    />
  );
}
