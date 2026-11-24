import { useEffect, useState } from "react";
import { api } from "./api.js";

// One shared list of product categories for every screen. It is loaded once
// per page and updated in place when someone adds a category.
let cached = null;
let loading = null;
const listeners = new Set();

function publish(next) {
  cached = next;
  for (const listener of listeners) listener(next);
}

function load() {
  if (!loading) {
    loading = api("/api/categories")
      .then((data) => {
        publish(data.categories || []);
        return cached;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

export function useCategories() {
  const [categories, setCategories] = useState(cached || []);
  useEffect(() => {
    listeners.add(setCategories);
    if (cached) setCategories(cached);
    else load().catch(() => {});
    return () => listeners.delete(setCategories);
  }, []);
  return categories;
}

// Adds a category (or returns the existing one with that name) and returns its name.
export async function addCategory(officeId, name) {
  const saved = await api(`/api/offices/${officeId}/categories`, { method: "POST", body: { name } });
  const list = cached || [];
  if (!list.some((item) => item.toLowerCase() === saved.name.toLowerCase())) {
    const others = list.filter((item) => item.toLowerCase() !== "other");
    const other = list.filter((item) => item.toLowerCase() === "other");
    publish([...others, saved.name].sort((a, b) => a.localeCompare(b)).concat(other));
  }
  return saved.name;
}
