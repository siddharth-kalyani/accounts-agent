import { api } from "../api.js";
import { PickOrAdd } from "./PickMenu.jsx";

export const OTHER = "Other";

// The office's Other product, where receipt lines that fit no product go.
export function otherProduct(products) {
  return products.find((product) => product.name.trim().toLowerCase() === OTHER.toLowerCase());
}

// Product picker for Receipt and Purchase. `withOther` offers Other (an empty
// value) when the office has no Other product yet: receipt review adds it with
// the purchases. With `officeId`, "+ Add product" saves a typed name as a product
// of that office at once (`onAdded` refreshes the pantry), then picks it; a name
// the office already has picks that product.
export function ProductMenu({ products, value, onChange, label = "Product", withOther = false, officeId, onAdded }) {
  const options = products.map((product) => ({ value: product.productId, label: product.name }));

  async function add(name) {
    const known = products.find((product) => product.name.trim().toLowerCase() === name.toLowerCase());
    if (known) {
      onChange(known.productId, known);
      return;
    }
    const saved = await api(`/api/offices/${officeId}/products`, { method: "POST", body: { name } });
    await onAdded?.(saved);
    onChange(saved.productId, saved);
  }

  return (
    <PickOrAdd
      options={withOther && !otherProduct(products) ? [...options, { value: "", label: OTHER, detail: "Added to this office with these purchases" }] : options}
      value={value}
      onChange={(productId) => onChange(productId, products.find((product) => product.productId === productId))}
      onAdd={officeId ? add : undefined}
      addLabel="Add product"
      nameLabel="Product name"
      cancelLabel="Cancel new product"
      label={label}
      placeholder="Choose a product"
      searchLabel="Search products"
      emptyText="No product matches that search."
    />
  );
}
