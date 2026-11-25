import { useEffect, useState } from "react";
import { api } from "./api.js";

// One shared list of suppliers for every screen, loaded once per page. A
// supplier is added on the server from "+ Add supplier", or when a purchase first
// names it; `remember` keeps a just-added name in the list without reloading.
let cached = null;
let loading = null;
const listeners = new Set();

function publish(next) {
  cached = next;
  for (const listener of listeners) listener(next);
}

function load() {
  if (!loading) {
    loading = api("/api/suppliers")
      .then((data) => {
        publish(data.suppliers || []);
        return cached;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

export function useSuppliers() {
  const [suppliers, setSuppliers] = useState(cached || []);
  useEffect(() => {
    listeners.add(setSuppliers);
    if (cached) setSuppliers(cached);
    else load().catch(() => {});
    return () => listeners.delete(setSuppliers);
  }, []);
  return suppliers;
}

export function rememberSupplier(name) {
  const clean = String(name || "").trim();
  if (!clean) return;
  const list = cached || [];
  if (list.some((item) => item.toLowerCase() === clean.toLowerCase())) return;
  publish([...list, clean].sort((a, b) => a.localeCompare(b)));
}
