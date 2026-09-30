import { PickMenu } from "./PickMenu.jsx";

export function ProductMenu({ products, value, onChange, label = "Product" }) {
  return (
    <PickMenu
      options={products.map((product) => ({ value: product.productId, label: product.name }))}
      value={value}
      onChange={onChange}
      label={label}
      placeholder="Choose a product"
      searchLabel="Search products"
      emptyText="No product matches that search."
    />
  );
}
