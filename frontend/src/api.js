let csrfToken = "";
let onUnauthorized = () => {};
let refreshing = null;

export function setCsrf(value) {
  csrfToken = value || "";
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

function authHeaders(method, extra = {}) {
  const headers = { ...extra };
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return headers;
}

function canRefresh(path) {
  return path !== "/api/auth/refresh" && !path.startsWith("/api/auth/password");
}

export function refreshSession() {
  if (!refreshing) {
    const refresh = async () => {
      // Cookies are shared between tabs. Re-check after obtaining the lock so
      // only one tab rotates a refresh token; replay detection stays strict.
      const current = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
      if (current.ok) {
        const data = await current.json();
        setCsrf(data.csrfToken);
        return data;
      }
      if (current.status !== 401) throw new Error("The pantry is unavailable. Try again.");
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || "Sign in again.");
        error.status = response.status;
        throw error;
      }
      setCsrf(data.csrfToken);
      return data;
    };
    const locks = globalThis.navigator?.locks;
    refreshing = (locks ? locks.request("aim-session-refresh", refresh) : refresh()).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function api(path, { method = "GET", body, retried = false, headers: extra = {}, keepalive = false } = {}) {
  const headers = authHeaders(method, extra);
  const passwordCall = path.startsWith("/api/auth/password");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Lets a pending Undo action finish when the tab closes.
    keepalive,
  });
  const type = response.headers.get("content-type") || "";
  if (response.ok && (type.includes("text/csv") || response.headers.get("content-disposition")?.startsWith("attachment"))) {
    return response.blob();
  }
  const data = await response.json().catch(() => ({}));
  if ((response.status === 401 || (response.status === 403 && data.code === "csrf")) && !retried && canRefresh(path)) {
    try {
      await refreshSession();
      return api(path, { method, body, retried: true, headers: extra, keepalive });
    } catch (error) {
      if (error.status === 401) { setCsrf(""); onUnauthorized(); }
      throw error;
    }
  } else if (response.status === 401 && !passwordCall) {
    setCsrf("");
    onUnauthorized();
  }
  if (!response.ok) {
    const error = new Error(data.error || "The request failed.");
    error.threadId = data.threadId || "";
    throw error;
  }
  return data;
}

export async function streamChat(body, onEvent, retried = false, signal) {
  const headers = authHeaders("POST", { "Content-Type": "application/json", Accept: "text/event-stream" });
  const response = await fetch("/api/chat", {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const data = await response.json().catch(() => ({}));
    if ((response.status === 401 || (response.status === 403 && data.code === "csrf")) && !retried) {
      try {
        await refreshSession();
        return streamChat(body, onEvent, true, signal);
      } catch (error) {
        if (error.status === 401) { setCsrf(""); onUnauthorized(); }
        throw error;
      }
    } else if (response.status === 401) {
      setCsrf("");
      onUnauthorized();
    }
    if (!response.ok) {
      const error = new Error(data.error || "The request failed.");
      error.threadId = data.threadId || "";
      throw error;
    }
    onEvent("done", data);
    return;
  }
  if (!response.body) throw new Error("The assistant could not reply.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let threadId = "";
  let finished = false;
  const handle = (raw) => {
    let eventName = "message";
    const dataLines = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join(""));
    if (data.threadId) threadId = data.threadId;
    if (eventName === "done" || eventName === "error") finished = true;
    onEvent(eventName, data);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      handle(chunk);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }
  if (buffer.trim()) handle(buffer);
  if (!finished) {
    const error = new Error("The assistant stopped before the reply finished.");
    error.threadId = threadId;
    throw error;
  }
}

export function rupee(value) {
  if (value == null || value === "") return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(Number(value));
}

export function indiaDate(iso) {
  if (!iso) return "—";
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function monthLabel(month) {
  const [year, mon] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, mon - 1, 1)));
}

export function packs(value) {
  if (value == null || value === "") return "—";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  const shown = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
  return `${shown} ${Math.abs(amount) === 1 ? "pack" : "packs"}`;
}

export function statusLabel(status) {
  if (status === "out") return "Out of stock";
  if (status === "due") return "Due";
  if (status === "not_enough_history") return "Not enough history";
  return "On track";
}

// Display-only reading of the server's figures. The server still decides
// on-hand, burn and status; a product at or below zero on hand is shown as
// out of stock, which is more urgent than due.
export function stockState(product) {
  if (product.status !== "not_enough_history" && Number(product.onHand) <= 0) return "out";
  return product.status;
}

// Calendar days from today to an ISO date (both Asia/Kolkata dates).
export function daysUntil(today, iso) {
  if (!today || !iso) return null;
  const [ty, tm, td] = today.split("-").map(Number);
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

export function runsOutWhen(product, today) {
  if (stockState(product) === "out") return "Out now";
  const days = daysUntil(today, product.expectedDate);
  if (days == null) return "";
  if (days <= 0) return "Now";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

// The last recorded day stock was above zero, from the server's own series.
export function ranOutOn(product) {
  const points = (product.series || []).filter((point) => !point.projected);
  let since = null;
  for (const point of points) {
    if (Number(point.onHand) > 0) since = null;
    else if (!since) since = point.date;
  }
  return since;
}

// Days of shelf counts before a forecast. Matches COUNT_DAYS_NEEDED in calc.py.
export const FORECAST_COUNT_DAYS = 14;

export function forecastWait(product) {
  const left = FORECAST_COUNT_DAYS - (Number(product.countedDays) || 0);
  if (left > 0 && left < FORECAST_COUNT_DAYS) return `After ${left} more ${left === 1 ? "day" : "days"} of counts`;
  return "After two weeks of counts";
}

// What the shelf should hold now: today's count when there is one, otherwise
// the server's on-hand in whole packs. Used to prefill a count, never saved by itself.
export function shelfEstimate(product) {
  if (product?.todayCount != null) return Number(product.todayCount);
  const onHand = Number(product?.onHand);
  return Number.isFinite(onHand) ? Math.max(0, Math.round(onHand)) : 0;
}

// On hand once a purchase is saved. A count already includes purchases dated
// on or before its day, so a purchase only adds when it is dated after the
// latest count; on or before, the count already holds it.
export function onHandAfter(product, date, added) {
  const base = shelfEstimate(product);
  const latest = (product?.countDates || []).at(-1) || "";
  const extra = Number(added);
  return date && date > latest && Number.isInteger(extra) && extra > 0 ? base + extra : base;
}

export function countNote(product) {
  if (product.todayCount != null) return "Counted today";
  if (product.lastCountedOn) return `Last counted ${indiaDate(product.lastCountedOn)}`;
  return "Not counted yet";
}

// A shelf count is a whole number of packs, zero or more.
export function wholePacks(value) {
  const text = String(value ?? "").trim();
  return /^\d{1,7}$/.test(text) && Number(text) <= 1000000 ? Number(text) : null;
}

// Packs a calendar week at the server's burn rate: five weekdays plus two
// weekend days at the company weekend weight.
export function weeklyUse(product, settings) {
  const burn = Number(product.burnRatePerEffectiveDay);
  if (!burn) return "";
  const weight = Number(settings?.weekendWeight ?? 0.2);
  const week = burn * (5 + 2 * weight);
  const round = (value) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
  const unit = (value) => (value === 1 ? "pack" : "packs");
  if (week >= 1) return `About ${round(week)} ${unit(round(week))} a week`;
  const month = round((week * 365) / 84);
  if (month < 0.1) return "Very little";
  return `About ${month} ${unit(month)} a month`;
}

export function indiaDay(at) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

export function indiaTime(at) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}
