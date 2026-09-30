import { useEffect, useState } from "react";
import { api, setCsrf, setUnauthorizedHandler } from "./api.js";
import { Dashboard } from "./screens/Dashboard.jsx";
import { SetPassword, SignIn } from "./screens/SignIn.jsx";

const THEME_KEY = "aim-theme";
const THEME_CHOICES = ["light", "dark", "system"];

function resolve(choice) {
  if (choice === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return choice === "dark" ? "dark" : "light";
}

function validChoice(value) {
  return THEME_CHOICES.includes(value) ? value : "light";
}

// Storage can be blocked (private windows, site-data policies). The theme then
// still applies for this visit; it just is not remembered.
function storedChoice() {
  try {
    return validChoice(localStorage.getItem(THEME_KEY));
  } catch {
    return "light";
  }
}

export function applyTheme(choice) {
  const mode = resolve(choice);
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.themeChoice = choice;
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* not remembered, still applied */
  }
  return mode;
}

export function App() {
  const [session, setSession] = useState(null);
  const [setupEmail, setSetupEmail] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [choice, setChoice] = useState(storedChoice);
  const [mode, setMode] = useState(() => resolve(storedChoice()));

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession((current) => {
        if (current === true) setAuthNotice("Your session ended. Sign in again.");
        return false;
      });
      setSetupEmail("");
    });
    api("/api/me")
      .then((data) => {
        setCsrf(data.csrfToken);
        setSetupEmail("");
        setAuthNotice("");
        setSession(true);
      })
      .catch(async () => {
        try {
          const response = await fetch("/api/auth/password/setup", { credentials: "same-origin" });
          if (response.ok) {
            const data = await response.json();
            setSetupEmail(data.email || "");
            setSession(false);
            return;
          }
          const data = await response.json().catch(() => ({}));
          if (response.status === 401 && data.error && data.error !== "Sign in with the invite password first.") setAuthNotice(data.error);
        } catch {
          /* show the sign-in page */
        }
        setSession(false);
      })
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    setMode(applyTheme(choice));
    if (choice !== "system") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setMode(applyTheme("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  // A choice made in another tab follows here too.
  useEffect(() => {
    function onStorage(event) {
      if (event.key === THEME_KEY) setChoice(validChoice(event.newValue));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const theme = { choice, setChoice, mode };
  if (!ready) {
    return (
      <main className="sign">
        <section className="sign-panel">
          <p className="lede">Opening the pantry.</p>
        </section>
      </main>
    );
  }
  if (setupEmail) {
    return (
      <SetPassword
        theme={theme}
        email={setupEmail}
        onSuccess={() => {
          setAuthNotice("");
          setSetupEmail("");
          setSession(true);
        }}
      />
    );
  }
  if (!session) {
    return (
      <SignIn
        theme={theme}
        notice={authNotice}
        onSetup={(email) => {
          setAuthNotice("");
          setSetupEmail(email);
        }}
        onSuccess={() => {
          setAuthNotice("");
          setSession(true);
        }}
      />
    );
  }
  return (
    <Dashboard
      theme={theme}
      onSignOut={async () => {
        await api("/api/auth/logout", { method: "POST", body: {} });
        setCsrf("");
        setSession(false);
      }}
    />
  );
}

export function ThemeSwitch({ choice, setChoice }) {
  const options = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
  ];
  return (
    <div className="theme" role="group" aria-label="Colour mode">
      {options.map(([value, label]) => (
        <button key={value} type="button" aria-pressed={choice === value} onClick={() => setChoice(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Logo({ mode, className = "logo" }) {
  const src = mode === "dark" ? "/brand/logo-on-dark.svg" : "/brand/logo-on-light.svg";
  return <img className={className} src={src} alt="Intuitive" />;
}
