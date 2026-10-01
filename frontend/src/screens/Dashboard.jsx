import { useCallback, useEffect, useRef, useState } from "react";
import { api, countNote, FORECAST_COUNT_DAYS, forecastWait, indiaDate, indiaDay, indiaTime, monthLabel, packs, ranOutOn, rupee, runsOutWhen, setCsrf, statusLabel, stockState, weeklyUse } from "../api.js";
import { useFocusTrap } from "../focus.js";
import { Logo } from "../App.jsx";
import { AccessPanel } from "../components/AccessPanel.jsx";
import { ChatDock } from "../components/ChatPanel.jsx";
import { DateRange, OfficeCompare, PantryCharts } from "../components/PantryCharts.jsx";
import { OfficeBar } from "../components/OfficeBar.jsx";
import { OfficesPanel } from "../components/OfficesPanel.jsx";
import { RecordPanel } from "../components/RecordPanel.jsx";
import { ProductEditor } from "../components/ProductEditor.jsx";
import { Purchases } from "../components/Purchases.jsx";
import { SettingsPanel } from "../components/SettingsPanel.jsx";
import { TodayStock } from "../components/TodayStock.jsx";
import { EmptyState, Pending } from "../components/Illustration.jsx";
import { LoadFailed, Skeleton } from "../components/Skeleton.jsx";
import { ToastStack } from "../components/Toasts.jsx";
import {
  IconAccess,
  IconActivity,
  IconChart,
  IconChevron,
  IconClose,
  IconCount,
  IconLogout,
  IconMenu,
  IconMoon,
  IconOffice,
  IconReceipt,
  IconRecord,
  IconSettings,
  IconChevronLeft,
  IconStock,
  IconSun,
  IconSystem,
} from "../icons.jsx";

const PANTRY_VIEWS = ["record", "stock", "purchases", "charts", "activity"];
const ADMIN_VIEWS = ["offices", "access", "settings"];
const PANTRY_NAV = [
  ["record", "Record", IconRecord],
  ["stock", "Stock", IconStock],
  ["purchases", "Purchases", IconReceipt],
  ["charts", "Charts", IconChart],
  ["activity", "Activity", IconActivity],
];
// Activity filters, by the start of each logged action.
const ACTIVITY_KINDS = [
  ["all", "All", () => true],
  ["purchases", "Purchases", (action) => /^(purchase|receipt)\./.test(action)],
  ["counts", "Counts", (action) => /^count\./.test(action)],
  ["products", "Products", (action) => /^product\./.test(action)],
  ["admin", "Admin", (action) => /^(office|grant|person|settings)\./.test(action)],
];
const UNDO_MS = 6000;
const SIDEBAR_KEY = "aim-sidebar";

function activityIcon(action) {
  if (/^(purchase|receipt)\./.test(action)) return <IconReceipt size={18} />;
  if (/^count\./.test(action)) return <IconCount size={18} />;
  if (/^product\./.test(action)) return <IconStock />;
  if (/^office\./.test(action)) return <IconOffice />;
  if (/^settings\./.test(action)) return <IconSettings />;
  return <IconAccess />;
}

function dayHeading(day, today) {
  if (day === today) return "Today";
  const [y, m, d] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  if (day === yesterday) return "Yesterday";
  const [yy, mm, dd] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(yy, mm - 1, dd)));
}
const ADMIN_NAV = [
  ["offices", "Offices", IconOffice],
  ["access", "Access", IconAccess],
  ["settings", "Settings", IconSettings],
];
const TITLES = {
  record: "Record",
  stock: "Stock",
  purchases: "Purchases",
  charts: "Charts",
  activity: "Activity",
  offices: "Offices",
  access: "Access",
  settings: "Settings",
};

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const month = params.get("month") || "";
  return {
    view: params.get("view") || "stock",
    office: params.get("office") || "",
    month: /^\d{4}-\d{2}$/.test(month) ? month : "",
  };
}

function indiaMonth(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(date);
}

function allowedView(view, person) {
  if (PANTRY_VIEWS.includes(view)) return view;
  if (person?.superAdmin && ADMIN_VIEWS.includes(view)) return view;
  return "stock";
}

function safeMonth(value) {
  return /^\d{4}-\d{2}$/.test(value || "") ? monthLabel(value) : "this month";
}

function showSummary(summary) {
  return String(summary || "").replace(/\b(20\d{2}-\d{2}-\d{2})\b/g, (iso) => indiaDate(iso));
}

function roleLine(person) {
  if (!person) return "";
  if (person.superAdmin) return "Super Admin";
  if (person.admin) return "Admin";
  const grants = person.grants || [];
  const managers = grants.filter((grant) => grant.role === "office_manager" && grant.officeName);
  if (managers.length) return `Office Manager · ${managers.map((grant) => grant.officeName).join(", ")}`;
  const accounts = grants.filter((grant) => grant.role === "accounts" && grant.officeName);
  if (accounts.length) return `Accounts · ${accounts.map((grant) => grant.officeName).join(", ")}`;
  return "No role yet";
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase()).join("") || "I";
}

export function Dashboard({ theme, onSignOut }) {
  const starting = useRef(readLocation());
  const [me, setMe] = useState(null);
  const [offices, setOffices] = useState([]);
  const [officesReady, setOfficesReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [officeId, setOfficeId] = useState("");
  const [allOffices, setAllOffices] = useState(false);
  const [summary, setSummary] = useState(null);
  const [month, setMonth] = useState(starting.current.month);
  const [pantry, setPantry] = useState(null);
  const [pantryLoading, setPantryLoading] = useState(false);
  // Set when the latest office load failed. Kept apart from the page error,
  // which is cleared on navigation, so a failed load never looks like loading.
  const [pantryFailed, setPantryFailed] = useState(false);
  const [activity, setActivity] = useState(null);
  const [stockQuery, setStockQuery] = useState("");
  const [activityQuery, setActivityQuery] = useState("");
  const [health, setHealth] = useState(null);
  const [view, setView] = useState(() => (PANTRY_VIEWS.includes(starting.current.view) ? starting.current.view : "stock"));
  const [groups, setGroups] = useState({ pantry: true, admin: true });
  const [menuOpen, setMenuOpen] = useState(false);
  // Desktop only: the sidebar can shrink to an icon rail. Remembered per browser,
  // like the theme; phones always use the full drawer.
  const [collapsedChoice, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 981px)").matches);
  const collapsed = collapsedChoice && wide;
  const [actRange, setActRange] = useState({ from: "", to: "" });
  const [chartRange, setChartRange] = useState({ from: "", to: "" });
  const [error, setError] = useState("");
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [activityKind, setActivityKind] = useState("all");
  const [activityFailed, setActivityFailed] = useState(false);
  const [activityReload, setActivityReload] = useState(0);
  const [recordKind, setRecordKind] = useState("receipt");
  // Today's stock dialog on Stock.
  const [counting, setCounting] = useState(false);
  const officeRequest = useRef(0);
  const purchaseRequest = useRef(null);
  // Removals waiting behind an Undo toast: id -> { commit, revert }.
  const pendingUndo = useRef(new Map());
  const side = useFocusTrap(menuOpen, () => setMenuOpen(false));

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((text, tone = "ok") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-4), { id, text, tone }]);
  }, []);

  // A removal is shown at once and sent when its toast closes (timeout, close
  // button, or pushed out by newer toasts). Undo cancels it before anything
  // reaches the server, so no restore route is needed.
  const scheduleUndo = useCallback(({ text, commit, revert }) => {
    const id = crypto.randomUUID();
    pendingUndo.current.set(id, { commit, revert });
    setToasts((current) => [...current.slice(-4), { id, text, tone: "ok", undo: true, duration: UNDO_MS }]);
  }, []);

  const undoToast = useCallback((id) => {
    const entry = pendingUndo.current.get(id);
    pendingUndo.current.delete(id);
    entry?.revert?.();
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const runUndoable = useCallback((entry, options) => Promise.resolve()
    .then(() => entry.commit(options))
    .catch((err) => {
      entry.revert?.();
      pushToast(err?.message || "That change could not be saved.", "error");
    }), [pushToast]);

  useEffect(() => {
    const live = new Set(toasts.map((toast) => toast.id));
    for (const [id, entry] of pendingUndo.current) {
      if (live.has(id)) continue;
      pendingUndo.current.delete(id);
      runUndoable(entry);
    }
  }, [toasts, runUndoable]);

  const flushUndo = useCallback((options) => {
    const entries = [...pendingUndo.current.values()];
    pendingUndo.current.clear();
    return Promise.all(entries.map((entry) => runUndoable(entry, options)));
  }, [runUndoable]);

  useEffect(() => {
    const onHide = () => { flushUndo({ keepalive: true }); };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      // Leaving the dashboard (for example, sign out) still sends what was not undone.
      flushUndo({ keepalive: true });
    };
  }, [flushUndo]);

  // The drawer is a phone layout. Leaving it open while widening would keep focus trapped.
  // The collapsed rail is a desktop layout; phones always get the full drawer.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 981px)");
    const onChange = () => {
      setWide(query.matches);
      if (query.matches) setMenuOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  async function loadOffice(nextOffice, nextMonth, person = me) {
    if (!nextOffice) return;
    const request = ++officeRequest.current;
    setPantryLoading(true);
    setPantryFailed(false);
    try {
      const pantryData = await api(`/api/offices/${nextOffice}/pantry?month=${encodeURIComponent(nextMonth)}`);
      if (request !== officeRequest.current) return;
      setPantry(pantryData);
      setPantryLoading(false);
      if (person?.seesEveryOffice) {
        const summaryData = await api(`/api/pantry/summary?month=${encodeURIComponent(nextMonth)}`);
        if (request === officeRequest.current) setSummary(summaryData);
      } else if (request === officeRequest.current) {
        setSummary(null);
      }
    } catch (err) {
      if (request === officeRequest.current) setPantryFailed(true);
      throw err;
    } finally {
      if (request === officeRequest.current) setPantryLoading(false);
    }
  }

  async function reloadScreen(nextOffice = officeId, nextMonth = month, person = me) {
    const officeData = await api("/api/offices");
    setOffices(officeData.offices);
    const known = officeData.offices.some((office) => office.id === nextOffice);
    const resolved = known ? nextOffice : officeData.offices[0]?.id || "";
    if (!known) {
      setAllOffices(false);
      setOfficeId(resolved);
    }
    if (resolved) await loadOffice(resolved, nextMonth, person);
    return officeData;
  }

  useEffect(() => {
    const messages = {
      directory_ready: "Directory search is connected.",
      not_configured: "Microsoft sign-in is not configured on this server yet.",
      failed: "That Microsoft step did not complete. Try again.",
    };
    const params = new URLSearchParams(window.location.search);
    const code = params.get("auth") || "";
    if (messages[code]) {
      if (code === "directory_ready") pushToast(messages[code]);
      else setError(messages[code]);
    }
    if (code) {
      params.delete("auth");
      const qs = params.toString();
      window.history.replaceState({}, "", qs ? `/?${qs}` : "/");
    }
    let cancel = false;
    Promise.all([api("/api/me"), api("/api/offices")])
      .then(async ([mine, officeData]) => {
        if (cancel) return;
        setCsrf(mine.csrfToken);
        setMe(mine.person);
        setOffices(officeData.offices);
        setHealth({ chatConfigured: mine.chatConfigured });
        const wanted = starting.current;
        const nextView = allowedView(wanted.view, mine.person);
        setView(nextView);
        const currentMonth = wanted.month || indiaMonth();
        setMonth(currentMonth);
        const list = officeData.offices;
        let nextAll = false;
        let nextId = "";
        if (wanted.office === "all" && mine.person.seesEveryOffice) {
          nextAll = true;
          nextId = list[0]?.id || "";
        } else if (list.some((office) => office.id === wanted.office)) {
          nextId = wanted.office;
        } else {
          nextId = list[0]?.id || "";
        }
        setAllOffices(nextAll);
        setOfficeId(nextId);
        setOfficesReady(true);
        setBooted(true);
        if (nextId) {
          try {
            await loadOffice(nextId, currentMonth, mine.person);
          } catch (err) {
            if (!cancel) setError(err.message);
          }
        }
      })
      .catch((err) => {
        if (cancel) return;
        setError(err.message);
        setOfficesReady(true);
        setBooted(true);
      });
    return () => {
      cancel = true;
    };
  }, [pushToast]);

  useEffect(() => {
    if (!booted) return;
    const params = new URLSearchParams();
    if (view !== "stock") params.set("view", view);
    if (allOffices && me?.seesEveryOffice) params.set("office", "all");
    else if (officeId) params.set("office", officeId);
    if (/^\d{4}-\d{2}$/.test(month)) params.set("month", month);
    const next = params.toString() ? `/?${params}` : "/";
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== next) window.history.replaceState({}, "", next);
  }, [booted, view, allOffices, officeId, month, me]);

  useEffect(() => {
    if (!pantry) return;
    const firstMonth = pantry.products.map((product) => product.history?.[0]?.month).filter(Boolean).sort()[0];
    const from = firstMonth ? `${firstMonth}-01` : pantry.today;
    setActRange((current) => (current.from ? current : { from, to: pantry.today }));
    const dates = pantry.products.flatMap((product) => (product.series || []).map((point) => point.date)).sort();
    if (dates.length) {
      setChartRange((current) => (current.from ? current : { from: dates[0], to: dates[dates.length - 1] }));
    }
  }, [pantry]);

  useEffect(() => {
    if (!officeId || !actRange.from || !actRange.to) return undefined;
    let cancel = false;
    setActivity(null);
    setActivityFailed(false);
    api(`/api/offices/${officeId}/operations?from=${encodeURIComponent(actRange.from)}&to=${encodeURIComponent(actRange.to)}`)
      .then((data) => {
        if (!cancel) setActivity(data.operations);
      })
      .catch((err) => {
        if (cancel) return;
        setActivityFailed(true);
        setError(err.message);
      });
    return () => {
      cancel = true;
    };
  }, [officeId, actRange.from, actRange.to, activityReload]);

  useEffect(() => {
    setActRange({ from: "", to: "" });
    setChartRange({ from: "", to: "" });
    setActivity(null);
    setActivityKind("all");
  }, [officeId]);

  useEffect(() => {
    const node = document.querySelector(".page");
    if (node) node.scrollTop = 0;
  }, [view, officeId]);

  const products = (pantry?.products || []).filter((product) => !product.deletedAt);
  const stockNeedle = stockQuery.trim().toLowerCase();
  const stockList = products.filter((product) => !stockNeedle || product.name.toLowerCase().includes(stockNeedle) || statusLabel(stockState(product)).toLowerCase().includes(stockNeedle));
  const officeList = (summary?.offices || []).filter((office) => !stockNeedle || office.name.toLowerCase().includes(stockNeedle));
  const activityNeedle = activityQuery.trim().toLowerCase();
  const activityFilter = (ACTIVITY_KINDS.find(([id]) => id === activityKind) || ACTIVITY_KINDS[0])[2];
  const activityList = (activity || []).filter((item) => activityFilter(item.action || "") && (!activityNeedle || `${item.actor} ${item.summary}`.toLowerCase().includes(activityNeedle)));
  const activityDays = [];
  for (const item of activityList) {
    const day = item.at ? indiaDay(item.at) : "";
    const group = activityDays[activityDays.length - 1];
    if (group?.day === day) group.items.push(item);
    else activityDays.push({ day, items: [item] });
  }
  const countedToday = products.filter((product) => product.todayCount != null).length;
  const outOfStock = products.filter((product) => stockState(product) === "out");
  const due = products.filter((product) => stockState(product) === "due");
  const learning = products.length > 0 && products.every((product) => product.status === "not_enough_history");
  const forecastSpend = allOffices ? summary?.forecastSpend : pantry?.forecast?.spend;
  const forecastMonth = allOffices ? summary?.forecastMonth : pantry?.forecast?.month;
  const forecastDays = allOffices ? summary?.effectiveDays : pantry?.forecast?.effectiveDays;
  const selectedOffice = offices.find((office) => office.id === officeId);
  const officeName = allOffices ? "All offices" : selectedOffice?.name || pantry?.officeName || "Office";
  const activityOffice = selectedOffice?.name || pantry?.officeName || "this office";
  const heroReady = allOffices ? Boolean(summary) : Boolean(pantry);
  const section = TITLES[view] || "Stock";
  const monthName = safeMonth(month);

  function toggleSidebar(next = !collapsedChoice) {
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "open");
    } catch {
      /* not remembered, still applied */
    }
  }

  function openView(next) {
    setView(next);
    setRecordKind("receipt");
    setError("");
    setMenuOpen(false);
  }

  function openRecord(kind) {
    openView("record");
    setRecordKind(kind);
  }

  async function refresh() {
    if (officeId) await loadOffice(officeId, month, me);
  }

  // After a failed load there is no data to show; offer a retry instead of a
  // skeleton that would look like it is still loading.
  function retryOffice() {
    setError("");
    refresh().catch((err) => setError(err.message));
  }

  const officeFailed = pantryFailed && !pantryLoading;

  async function officesChanged(office) {
    const officeData = await api("/api/offices");
    setOffices(officeData.offices);
    if (office?.id) {
      setView("stock");
      setAllOffices(false);
      setOfficeId(office.id);
      setPantry(null);
      setSummary(null);
      await loadOffice(office.id, month, me);
      return;
    }
    if (officeId) await loadOffice(officeId, month, me);
  }

  async function submit(form, receipt) {
    setBusy(true);
    setError("");
    try {
      let toast = "";
      if (form.kind === "attach") {
        await api(`/api/purchases/${form.purchaseId}/receipt`, { method: "PUT", body: { receipt } });
        purchaseRequest.current = null;
        toast = "Receipt attached.";
      } else if (form.kind === "product") {
        await api(`/api/offices/${officeId}/products`, { method: "POST", body: { name: form.name } });
        toast = `Added ${form.name}.`;
      } else if (form.kind === "purchase") {
        const fingerprint = JSON.stringify({ officeId, form, receipt });
        if (purchaseRequest.current?.fingerprint !== fingerprint) purchaseRequest.current = { fingerprint, key: crypto.randomUUID() };
        const saved = await api(`/api/offices/${officeId}/purchases`, {
          method: "POST",
          headers: { "Idempotency-Key": purchaseRequest.current.key },
          body: {
            productId: form.productId,
            date: form.date,
            packs: Number(form.packs),
            pricePerPack: form.price,
            ...(form.onHand != null ? { onHand: form.onHand } : {}),
            receipt,
          },
        });
        if (saved.receiptError) {
          setError(saved.receiptError);
          try {
            await reloadScreen();
          } catch {
            setError((previous) => [previous, "Saved, but the screen could not refresh. Reload to see the updated pantry."].filter(Boolean).join(" "));
          }
          return { purchaseId: saved.purchaseId };
        }
        purchaseRequest.current = null;
        toast = form.onHand != null ? "Purchase and today's stock saved." : "Purchase saved.";
      } else if (form.kind === "count") {
        await api(`/api/offices/${officeId}/counts`, {
          method: "PUT",
          body: { productId: form.productId, date: form.date, packs: Number(form.packs) },
        });
        toast = "Count saved.";
      }
      try {
        await reloadScreen();
      } catch {
        setError("Saved, but the screen could not refresh. Reload to see the updated pantry.");
      }
      if (toast) pushToast(toast);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setError("");
    try {
      const blob = await api(`/api/offices/${officeId}/export?month=${encodeURIComponent(month)}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${pantry?.officeName || "pantry"}-${month}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  function chooseOffice(id) {
    setAllOffices(false);
    setOfficeId(id);
    setPantry(null);
    setSummary(null);
    setError("");
    loadOffice(id, month, me).catch((err) => setError(err.message));
  }

  function chooseAll() {
    setAllOffices(true);
    setError("");
    if (officeId) loadOffice(officeId, month, me).catch((err) => setError(err.message));
  }

  function changeMonth(next) {
    setMonth(next);
    setPantry(null);
    setSummary(null);
    if (officeId) loadOffice(officeId, next, me).catch((err) => setError(err.message));
  }

  return (
    <div className={`shell${collapsed ? " side-collapsed" : ""}`}>
      <aside
        id="side-menu"
        className={`side${menuOpen ? " open" : ""}`}
        ref={side}
        tabIndex={-1}
        aria-label="Menu"
        {...(menuOpen ? { role: "dialog", "aria-modal": "true" } : {})}
      >
        <div className="side-head">
          <Logo mode={theme.mode} />
          {/* Desktop: collapse or expand. The chevron turns to point the way the sidebar will move. */}
          <button
            className="side-head-button side-toggle"
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="side-menu"
            onClick={() => toggleSidebar()}
          >
            <IconChevronLeft />
          </button>
          {/* Phones: the drawer's close button takes the same place. */}
          <button className="side-head-button side-close" type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <IconClose />
          </button>
        </div>
        <div className="side-scroll">
          <div className="nav-group">
            {collapsed ? <div className="nav-divider" role="separator" aria-label="Pantry" /> : (
              <button
                className="nav-parent"
                type="button"
                aria-expanded={groups.pantry}
                onClick={() => setGroups((current) => ({ ...current, pantry: !current.pantry }))}
              >
                <span className="chevron"><IconChevron /></span>
                <span className="nav-text">Pantry</span>
              </button>
            )}
            {groups.pantry || collapsed ? (
              <div className="nav-sub">
                {PANTRY_NAV.map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    className="nav-item"
                    aria-current={view === id ? "page" : undefined}
                    title={collapsed ? label : undefined}
                    onClick={() => openView(id)}
                  >
                    <Icon /> <span className="nav-text">{label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {me?.superAdmin ? (
            <div className="nav-group">
              {collapsed ? <div className="nav-divider" role="separator" aria-label="Super Admin" /> : (
                <button
                  className="nav-parent"
                  type="button"
                  aria-expanded={groups.admin}
                  onClick={() => setGroups((current) => ({ ...current, admin: !current.admin }))}
                >
                  <span className="chevron"><IconChevron /></span>
                  <span className="nav-text">Super Admin</span>
                </button>
              )}
              {groups.admin || collapsed ? (
                <div className="nav-sub">
                  {ADMIN_NAV.map(([id, label, Icon]) => (
                    <button
                      key={id}
                      type="button"
                      className="nav-item"
                      aria-current={view === id ? "page" : undefined}
                      title={collapsed ? label : undefined}
                      onClick={() => openView(id)}
                    >
                      <Icon /> <span className="nav-text">{label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="side-bottom">
          {/* The rail is too narrow for the office menu; this opens the sidebar to pick one. */}
          <button
            className="icon-button side-mini-office"
            type="button"
            title={`Office: ${officeName}`}
            aria-label={`Office: ${officeName}. Expand the sidebar to change it`}
            onClick={() => toggleSidebar(false)}
          >
            <IconOffice />
          </button>
          <OfficeBar
            offices={offices}
            officeId={officeId}
            allOffices={allOffices}
            seesEveryOffice={Boolean(me?.seesEveryOffice)}
            onChoose={chooseOffice}
            onAll={chooseAll}
            variant="side"
          />
          <div className="account" title={collapsed && me ? `${me.displayName} · ${roleLine(me)}` : undefined}>
            <span className="avatar" aria-hidden="true">{initials(me?.displayName)}</span>
            <div className="account-text">
              <strong>{me?.displayName || "…"}</strong>
              <span>{me?.email}</span>
              {me ? <span className="role-line">{roleLine(me)}</span> : null}
            </div>
          </div>
          <div className="theme-icons" role="group" aria-label="Colour mode">
            <button type="button" aria-label="Light" aria-pressed={theme.choice === "light"} onClick={() => theme.setChoice("light")}><IconSun /></button>
            <button type="button" aria-label="Dark" aria-pressed={theme.choice === "dark"} onClick={() => theme.setChoice("dark")}><IconMoon /></button>
            <button type="button" aria-label="System" aria-pressed={theme.choice === "system"} onClick={() => theme.setChoice("system")}><IconSystem /></button>
          </div>
          <button className="nav-item logout" type="button" title={collapsed ? "Log out" : undefined} onClick={() => flushUndo().then(() => onSignOut()).catch(() => setError("Log out could not be completed. Check your connection and try again."))}>
            <IconLogout /> <span className="nav-text">Log out</span>
          </button>
        </div>
      </aside>
      {menuOpen ? <button className="backdrop" type="button" aria-hidden="true" tabIndex={-1} onClick={() => setMenuOpen(false)} /> : null}

      <header className="top">
        <button className="icon-button menu-button" type="button" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <IconMenu />
        </button>
        {/* Phones only; desktop shows the logo at the top of the sidebar. */}
        <img className="logo" src="/brand/logo-on-dark.svg" alt="Intuitive" />
        <strong className="section-name">{section}</strong>
        <div className="top-spacer" />
        <div className="controls top-controls">
          <input
            className="month"
            aria-label="Month"
            type="month"
            value={month}
            onChange={(event) => changeMonth(event.target.value)}
            onClick={(event) => {
              // The whole box opens the picker, not just the calendar icon.
              try {
                event.currentTarget.showPicker?.();
              } catch {
                /* the browser opens its own picker */
              }
            }}
          />
        </div>
      </header>

      <main className="page">
        {error ? (
          <div className="error page-alert" role="alert">
            <span>{error}</span>
            <button className="texty" type="button" onClick={() => setError("")}>Dismiss</button>
          </div>
        ) : null}

        {!officesReady ? <Skeleton label="Loading the pantry." variant="hero" /> : null}

        {officesReady && !offices.length && !ADMIN_VIEWS.includes(view) ? (
          <section className="card">
            <EmptyState
              art="office"
              title="No office yet"
              actions={me?.superAdmin ? <button className="solid small" type="button" onClick={() => openView("offices")}>Add an office</button> : null}
            >
              {me?.superAdmin
                ? "Add an office from Offices. It starts with Coffee, Milk, Sugar, Tea, and Sticks at zero packs."
                : "No office is assigned to this sign-in."}
            </EmptyState>
          </section>
        ) : null}

        {view === "offices" && me?.superAdmin ? (
          <OfficesPanel offices={offices} onChanged={officesChanged} onToast={pushToast} onUndoable={scheduleUndo} />
        ) : null}
        {view === "access" && me?.superAdmin ? <AccessPanel offices={offices} onToast={pushToast} onUndoable={scheduleUndo} /> : null}
        {view === "settings" && me?.superAdmin ? (
          <SettingsPanel
            settings={pantry?.settings}
            officeId={officeId}
            officeName={selectedOffice?.name || pantry?.officeName}
            onSaved={refresh}
            onToast={pushToast}
          />
        ) : null}

        {offices.length > 0 && (view === "stock" || view === "charts") ? (
          heroReady ? (
            <section className="hero">
              <div>
                <p className="eyebrow"><Star /> Spent in {monthName}</p>
                <h1>{allOffices ? rupee(summary.spend) : rupee(pantry.spend)}</h1>
                <p>{allOffices ? "All offices" : pantry.officeName}</p>
              </div>
              <div className="hero-forecast">
                <p className="eyebrow">Next month</p>
                <p className="forecast-figure">{forecastSpend ? rupee(forecastSpend) : "Not yet"}</p>
                <p className="hero-explain" title={forecastDays ? `${forecastDays} working days, with weekends counted at the company weekend weight` : undefined}>
                  {forecastSpend && forecastMonth
                    ? `Estimate for ${monthLabel(forecastMonth)} if use continues at the current rate.`
                    : "Shown after two weeks of shelf counts."}
                </p>
              </div>
              <div className="hero-side">
                {allOffices ? (
                  <p>Due stays on each office.</p>
                ) : (
                  <p>{heroStatus(outOfStock, due)}</p>
                )}
              </div>
            </section>
          ) : !officeFailed ? (
            <Skeleton label={`Loading ${monthName}.`} variant="hero" />
          ) : null
        ) : null}

        {offices.length > 0 && view === "record" ? (
          allOffices ? (
            <section className="card"><h2>Choose an office</h2><p className="lede">Record applies to one office. Pick it above your name.</p></section>
          ) : !pantry && officeFailed ? (
            <section className="card record-card"><h2>Record</h2><LoadFailed text={`${officeName} could not be loaded.`} onRetry={retryOffice} /></section>
          ) : (
            <RecordPanel
              key={officeId}
              pantry={pantry}
              officeId={officeId}
              officeName={selectedOffice?.name || pantry?.officeName}
              busy={busy}
              loading={!pantry}
              initialKind={recordKind}
              onSubmit={submit}
              onSaved={refresh}
              onToast={pushToast}
            />
          )
        ) : null}

        {offices.length > 0 && view === "stock" ? (
          <section className="card" style={{ marginTop: 18 }}>
            <div className="card-head">
              <div>
                <h2>{allOffices ? "Offices" : pantry?.officeName || officeName}</h2>
                {!allOffices && pantry && products.length ? (
                  <p className="lede-small">{countedToday} of {products.length} counted today</p>
                ) : null}
              </div>
              <div className="row-actions">
                {!allOffices && pantry?.canWrite && products.length ? (
                  <button className="solid with-icon" type="button" onClick={() => setCounting(true)}>
                    <IconCount size={18} /> Today&apos;s stock
                  </button>
                ) : null}
                <input
                  className="search"
                  type="text"
                  value={stockQuery}
                  placeholder={allOffices ? "Search offices" : "Search products"}
                  aria-label={allOffices ? "Search offices" : "Search products"}
                  onChange={(event) => setStockQuery(event.target.value)}
                />
                <button
                  className="ghost"
                  type="button"
                  onClick={download}
                  disabled={!officeId || allOffices || pantryLoading}
                  title={allOffices ? "Pick one office" : undefined}
                >
                  Download month
                </button>
              </div>
            </div>
            {allOffices ? <p className="note">Pick one office to download the month.</p> : null}
            {allOffices ? (
              summary ? (
              <div className="products">
                {officeList.length ? officeList.map((office) => (
                  <button className="product office-card" type="button" key={office.officeId} onClick={() => chooseOffice(office.officeId)}>
                    <h3>{office.name}</h3>
                    <p className="stat"><small className="muted">Spent in {monthName}</small>{rupee(office.spend)}</p>
                    <p className="stat"><small className="muted">Next month</small>{office.forecastSpend ? rupee(office.forecastSpend) : "Not yet"}</p>
                  </button>
                )) : <p className="note">No office matches that search.</p>}
              </div>
              ) : officeFailed ? <LoadFailed text="The offices could not be loaded." onRetry={retryOffice} /> : <Skeleton label="Loading offices." rows={2} />
            ) : !pantry ? (
              officeFailed ? <LoadFailed text={`${officeName} could not be loaded.`} onRetry={retryOffice} /> : <Skeleton label={`Loading ${officeName}.`} rows={4} />
            ) : (
              <>
                {learning && !stockNeedle ? (
                  <EmptyState
                    art="receipt"
                    className="teach"
                    title={`Start tracking ${pantry.officeName}`}
                    actions={pantry.canWrite ? (
                      <>
                        <button className="solid small" type="button" onClick={() => setCounting(true)}>Count today&apos;s stock</button>
                        <button className="ghost small" type="button" onClick={() => openRecord("receipt")}>Read a receipt</button>
                      </>
                    ) : null}
                  >
                    Count each shelf once a day and record purchases as they arrive. Run-out dates and next month&apos;s estimate start after two weeks of counts.
                  </EmptyState>
                ) : null}
                <div className="products">
                  {stockList.length ? stockList.map((product) => {
                    const state = stockState(product);
                    const since = state === "out" ? ranOutOn(product) : null;
                    const use = weeklyUse(product, pantry.settings);
                    return (
                      <article className={`product${state === "out" ? " is-out" : ""}`} key={product.productId}>
                        <div className="product-name">
                          <h3>{product.name}</h3>
                        </div>
                        <p className="stat">
                          <small className="muted">On hand today</small>{state === "out" ? "None left" : packs(product.onHand)}
                          <small className={`muted count-note${product.todayCount != null ? " is-counted" : ""}`}>{countNote(product)}</small>
                        </p>
                        <p className="stat stat-key">
                          <small className="muted">Runs out</small>
                          {state === "out" ? "Already out" : product.expectedDate ? indiaDate(product.expectedDate) : <Pending label="No run-out date yet" title={forecastWait(product)} />}
                          <small className="muted">
                            {state === "out"
                              ? since ? `Since about ${indiaDate(since)}` : "Record a count or a purchase"
                              : product.expectedDate ? runsOutWhen(product, pantry.today) : forecastWait(product)}
                          </small>
                        </p>
                        <p className="stat" title={product.burnRatePerEffectiveDay ? `${product.burnRatePerEffectiveDay} packs per working day` : undefined}>
                          <small className="muted">Usage</small>{use || <Pending label="Usage not known yet" title={forecastWait(product)} />}
                        </p>
                        <p className="stat"><small className="muted">Added in {monthName}</small>{packs(product.packsAdded)}</p>
                        <p className="stat">
                          <small className="muted">Spent in {monthName}</small>{rupee(product.spend)}
                          <small className="muted">{product.latestPricePerPack ? `Latest ${rupee(product.latestPricePerPack)}` : "No price this month"}</small>
                        </p>
                        <div className="product-end">
                          <span className={`pill ${state}`}>{statusLabel(state)}</span>
                          {pantry.canWrite ? <ProductEditor product={product} onSaved={refresh} onToast={pushToast} /> : null}
                        </div>
                        {/* While counts build up, Runs out already says how long; other messages explain a problem. */}
                        {product.message && !learning && Number(product.countedDays) >= FORECAST_COUNT_DAYS ? <p className="note">{product.message}</p> : null}
                      </article>
                    );
                  }) : stockQuery.trim() ? (
                    <p className="note">No product matches that search.</p>
                  ) : (
                    <EmptyState
                      art="box"
                      title="No products on this pantry."
                      actions={pantry.canWrite ? <button className="solid small" type="button" onClick={() => openRecord("product")}>Add a product</button> : null}
                    >
                      Add what the office buys, such as coffee or milk, to start tracking it.
                    </EmptyState>
                  )}
                </div>
                <button className="texty stock-more" type="button" onClick={() => openView("purchases")}>Purchases and receipts for {monthName}</button>
              </>
            )}
          </section>
        ) : null}

        {offices.length > 0 && view === "purchases" ? (
          allOffices ? (
            <section className="card"><h2>Choose an office</h2><p className="lede">Purchases are listed for one office. Pick it above your name.</p></section>
          ) : pantry ? (
            <Purchases
              key={`${officeId}-${month}`}
              officeId={officeId}
              officeName={pantry.officeName}
              month={month}
              monthName={monthName}
              revision={pantry}
              canWrite={Boolean(pantry.canWrite)}
              onChanged={refresh}
              onToast={pushToast}
              onUndoable={scheduleUndo}
              onRecord={openRecord}
            />
          ) : (
            <section className="card">
              {officeFailed ? <LoadFailed text={`${officeName} could not be loaded.`} onRetry={retryOffice} /> : <Skeleton label="Loading purchases." rows={3} />}
            </section>
          )
        ) : null}

        {offices.length > 0 && view === "charts" ? (
          (allOffices ? summary : pantry) ? (
            allOffices ? <OfficeCompare summary={summary} /> : <PantryCharts pantry={pantry} range={chartRange} onRange={setChartRange} />
          ) : (
            <section className="card">
              {officeFailed ? <LoadFailed text="The charts could not be loaded." onRetry={retryOffice} /> : <Skeleton label="Loading charts." rows={2} />}
            </section>
          )
        ) : null}

        {offices.length > 0 && view === "activity" ? (
          <section className="card activity">
            <div className="card-head filter-head">
              <div>
                <h2>Activity for {activityOffice}</h2>
                {allOffices ? <p className="lede-small">All offices is the total on Stock. This list is {activityOffice}.</p> : null}
              </div>
              <div className="row-actions">
                <input
                  className="search"
                  type="text"
                  value={activityQuery}
                  placeholder="Search activity"
                  aria-label="Search activity"
                  onChange={(event) => setActivityQuery(event.target.value)}
                />
                <DateRange range={actRange.from ? actRange : null} onRange={setActRange} label="Activity dates" />
              </div>
            </div>
            <div className="choices activity-kinds" role="group" aria-label="Show activity">
              {ACTIVITY_KINDS.map(([id, label]) => (
                <button key={id} type="button" className="choice" aria-pressed={activityKind === id} onClick={() => setActivityKind(id)}>{label}</button>
              ))}
            </div>
            {activity?.length === 300 ? <p className="note">This list stops at 300 rows. Narrow the dates to see the rest.</p> : null}
            {activity === null ? (
              activityFailed ? (
                <LoadFailed text="Activity could not be loaded." onRetry={() => { setError(""); setActivityReload((count) => count + 1); }} />
              ) : !pantry && officeFailed ? (
                // The date range comes from the pantry, so activity waits on it.
                <LoadFailed text={`${activityOffice} could not be loaded.`} onRetry={retryOffice} />
              ) : (
                <Skeleton label="Loading activity." rows={4} />
              )
            ) : activityDays.length ? activityDays.map((group) => (
              <section className="activity-day" key={group.day || "unknown"}>
                <h3 className="activity-date">{group.day ? dayHeading(group.day, pantry?.today || indiaDay(new Date())) : "Earlier"}</h3>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <span className="activity-icon" aria-hidden="true">{activityIcon(item.action || "")}</span>
                      <span className="activity-text"><strong>{item.actor}</strong> · {showSummary(item.summary)}</span>
                      <time className="muted" dateTime={item.at} title={item.atLabel}>{item.at ? indiaTime(item.at) : item.atLabel}</time>
                    </li>
                  ))}
                </ul>
              </section>
            )) : (
              <EmptyState
                art="activity"
                title={activityQuery.trim() ? "Nothing matches that search." : activityKind !== "all" ? "Nothing of that kind in these dates." : "Nothing in these dates."}
              >
                {activityQuery.trim() || activityKind !== "all" ? "Clear the search or pick All to see everything." : "Widen the dates to see older entries."}
              </EmptyState>
            )}
          </section>
        ) : null}
      </main>

      {counting && pantry && !allOffices ? (
        <TodayStock
          officeId={officeId}
          officeName={pantry.officeName}
          today={pantry.today}
          products={products}
          onClose={() => setCounting(false)}
          onSaved={refresh}
          onToast={pushToast}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} onUndo={undoToast} />
      <ChatDock
        configured={health?.chatConfigured}
        officeId={allOffices ? "" : officeId}
        officeName={allOffices ? "" : selectedOffice?.name || pantry?.officeName || ""}
        month={month}
        onSaved={refresh}
      />
    </div>
  );
}

function names(list) {
  const shown = list.map((product) => product.name);
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function heroStatus(out, due) {
  const parts = [];
  if (out.length) parts.push(`${names(out)} ${out.length === 1 ? "is" : "are"} out of stock.`);
  if (due.length) parts.push(`${names(due)} ${due.length === 1 ? "is" : "are"} due.`);
  return parts.length ? parts.join(" ") : "Nothing is due to run out soon.";
}

function Star() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 0 14.7 9.3 24 12 14.7 14.7 12 24 9.3 14.7 0 12 9.3 9.3Z" />
    </svg>
  );
}
