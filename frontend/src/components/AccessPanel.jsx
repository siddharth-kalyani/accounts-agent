import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useFocusTrap } from "../focus.js";
import { useMounted } from "../hooks.js";
import { IconClose, IconPlus, IconSearch } from "../icons.jsx";

const ROLES = [
  ["office_manager", "Office Manager"],
  ["accounts", "Accounts"],
  ["admin", "Admin"],
  ["super_admin", "Super Admin"],
];

const EMPTY = {
  directoryObjectId: "",
  signInName: "",
  displayName: "",
  role: "office_manager",
  officeId: "",
};

export function AccessPanel({ offices, onToast, onUndoable }) {
  const [people, setPeople] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [issued, setIssued] = useState(null);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  // Optimistic changes waiting on an Undo toast. Nothing is sent until it closes.
  const [removedGrants, setRemovedGrants] = useState(() => new Set());
  const [turnedOff, setTurnedOff] = useState(() => new Set());
  const mounted = useMounted();
  const panel = useFocusTrap(panelOpen, () => closePanel());

  async function load() {
    const data = await api("/api/access");
    if (!mounted.current) return;
    setPeople(data.people);
    setLoaded(true);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  function openPanel(person) {
    setFormError("");
    setNotice("");
    if (person) {
      setForm({ ...EMPTY, signInName: person.email, displayName: person.displayName, officeId: offices[0]?.id || "" });
    }
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setIssued(null);
    setNotice("");
    setFormError("");
  }

  function choose(person) {
    setForm({
      directoryObjectId: person.directoryObjectId || "",
      signInName: person.signInName || person.email || "",
      displayName: person.displayName || "",
      role: "office_manager",
      officeId: offices[0]?.id || "",
    });
  }

  async function search(event) {
    event.preventDefault();
    setFormError("");
    setNotice("");
    setBusy(true);
    try {
      const data = await api(`/api/directory/users?query=${encodeURIComponent(query.trim())}`);
      setResults(data.people);
    } catch (err) {
      setResults(null);
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    setFormError("");
    setNotice("");
    setBusy(true);
    try {
      const needsOffice = form.role === "office_manager" || form.role === "accounts";
      await api("/api/access", {
        method: "POST",
        body: {
          directoryObjectId: form.directoryObjectId || undefined,
          signInName: form.signInName,
          displayName: form.displayName,
          role: form.role,
          officeId: needsOffice ? form.officeId : undefined,
        },
      });
      setForm(EMPTY);
      setNotice("Access saved.");
      onToast?.("Access saved.");
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function invite(event) {
    event.preventDefault();
    setFormError("");
    setNotice("");
    setIssued(null);
    setBusy(true);
    try {
      const data = await api("/api/access/invite", {
        method: "POST",
        body: { email: inviteEmail, displayName: inviteName },
      });
      setIssued(data);
      // The same person usually needs a role next.
      setForm({ ...EMPTY, signInName: data.email, displayName: data.displayName, officeId: offices[0]?.id || "" });
      setInviteEmail("");
      setInviteName("");
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(issued.temporaryPassword);
      setNotice("Invite password copied.");
    } catch {
      setNotice("");
      setFormError("Select the invite password and copy it.");
    }
  }

  function forget(setter, id) {
    if (!mounted.current) return;
    setter((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function removeGrant(person, grant) {
    setError("");
    setRemovedGrants((current) => new Set(current).add(grant.id));
    onUndoable({
      text: `Removed ${grant.label} from ${person.displayName}.`,
      commit: async ({ keepalive } = {}) => {
        await api(`/api/access/${person.id}/grants/${grant.id}`, { method: "DELETE", keepalive });
        if (!keepalive) await load();
      },
      revert: () => forget(setRemovedGrants, grant.id),
    });
  }

  function turnOff(person) {
    setError("");
    setTurnedOff((current) => new Set(current).add(person.id));
    onUndoable({
      text: `Turned off ${person.displayName}. They are signed out.`,
      commit: async ({ keepalive } = {}) => {
        await api(`/api/access/${person.id}/active`, { method: "POST", body: { active: false }, keepalive });
        if (!keepalive) {
          await load();
          forget(setTurnedOff, person.id);
        }
      },
      revert: () => forget(setTurnedOff, person.id),
    });
  }

  async function turnOn(person) {
    setError("");
    setBusy(true);
    try {
      await api(`/api/access/${person.id}/active`, { method: "POST", body: { active: true } });
      onToast?.(`Turned ${person.displayName} back on.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const needsOffice = form.role === "office_manager" || form.role === "accounts";
  const view = people.map((person) => ({
    ...person,
    active: person.active && !turnedOff.has(person.id),
    grants: person.grants.filter((grant) => !removedGrants.has(grant.id)),
  }));
  // The server refuses to remove or turn off the last active Super Admin, so
  // those controls are not offered for that person.
  const activeSuperAdmins = view.filter((person) => person.active && person.grants.some((grant) => grant.role === "super_admin"));
  const lastSuperAdminId = activeSuperAdmins.length === 1 ? activeSuperAdmins[0].id : null;
  const peopleNeedle = peopleQuery.trim().toLowerCase();
  const shownPeople = view.filter((person) => !peopleNeedle || [
    person.displayName,
    person.email,
    person.active ? "" : "turned off",
    person.invitePending ? "invite pending" : "",
    ...person.grants.map((grant) => grant.label),
  ].join(" ").toLowerCase().includes(peopleNeedle));

  return (
    <section className="card access">
      <div className="card-head">
        <div>
          <h2>Access <span className="count">{people.length}</span></h2>
          <p className="lede-small">Everyone who can sign in, and what each person can do.</p>
        </div>
        <div className="row-actions">
          <button className="ghost" type="button" onClick={() => onToast?.("Directory search is under development.")}>Connect directory search</button>
          <button className="solid with-icon" type="button" onClick={() => openPanel(null)}><IconPlus /> Invite person</button>
        </div>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}

      <div className="access-people">
        <span className="search-field people-search">
          <IconSearch />
          <input
            type="search"
            aria-label="Search people on the access list"
            placeholder="Search by name, email, or role"
            value={peopleQuery}
            onChange={(event) => setPeopleQuery(event.target.value)}
          />
          {peopleQuery ? (
            <button className="search-clear" type="button" aria-label="Clear search" onClick={() => setPeopleQuery("")}>
              <IconClose />
            </button>
          ) : null}
        </span>
        {people.length > 0 && !shownPeople.length ? <p className="note">No person matches that search.</p> : null}
      </div>
      <ul className="access-list">
        {!loaded && !error ? (
          <li className="access-loading"><span className="sr-only">Loading people.</span><i className="sk sk-title" /><i className="sk sk-line" /></li>
        ) : null}
        {shownPeople.map((person) => (
          <li key={person.id}>
            <div className="access-person">
              <strong>{person.displayName}</strong>
              <span>{person.email}</span>
              <div className="role-chips">
                {!person.active ? <span className="role-chip off">Turned off</span> : null}
                {person.active && !person.grants.length ? <span className="role-chip empty">No role yet</span> : null}
                {person.active ? person.grants.map((grant) => {
                  const locked = grant.role === "super_admin" && person.id === lastSuperAdminId;
                  return (
                    <span className={`role-chip${grant.role === "super_admin" ? " strong" : ""}`} key={grant.id}>
                      {grant.label}
                      {locked ? null : (
                        <button type="button" aria-label={`Remove ${grant.label}`} title={`Remove ${grant.label}`} onClick={() => removeGrant(person, grant)}>
                          <IconClose />
                        </button>
                      )}
                    </span>
                  );
                }) : null}
                {person.invitePending ? <span className="role-chip wait">Invite not used yet</span> : null}
              </div>
              {person.id === lastSuperAdminId ? <span className="access-hint">The only Super Admin. Add another before removing this role.</span> : null}
            </div>
            <div className="access-actions">
              {person.active ? (
                <button className="ghost small" type="button" onClick={() => openPanel(person)}>Add a role</button>
              ) : null}
              {person.id === lastSuperAdminId ? null : person.active ? (
                <button className="ghost small" type="button" onClick={() => turnOff(person)}>Turn off</button>
              ) : (
                <button className="ghost small" type="button" disabled={busy} onClick={() => turnOn(person)}>Turn on</button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {panelOpen ? (
        <>
          <button className="drawer-back" type="button" aria-hidden="true" tabIndex={-1} onClick={() => { if (!issued) closePanel(); }} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="access-drawer-title" ref={panel} tabIndex={-1}>
            <header className="drawer-head">
              <h2 id="access-drawer-title">Invite or give access</h2>
              <button className="icon-button" type="button" aria-label="Close" title="Close" onClick={closePanel}><IconClose /></button>
            </header>
            <div className="drawer-body">
              {formError ? <p className="error" role="alert">{formError}</p> : null}
              {notice ? <p className="notice" role="status">{notice}</p> : null}
              <section className="drawer-section">
                <h3 className="panel-title">1. Invite by email</h3>
                <p className="note">Send the one-time password yourself. They choose their own password when they first sign in.</p>
                <form className="access-form" onSubmit={invite}>
                  <label>Name
                    <input value={inviteName} onChange={(event) => setInviteName(event.target.value)} placeholder="Optional" />
                  </label>
                  <label>Email to invite
                    <input
                      type="email"
                      required
                      placeholder="name@intuitive.AI"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                    />
                  </label>
                  <button className="solid" type="submit" disabled={busy}>Invite</button>
                </form>
                {issued ? (
                  <div className="invite-secret">
                    <p>Send this once to {issued.email}. It will not be shown again.</p>
                    <code>{issued.temporaryPassword}</code>
                    <button className="ghost" type="button" onClick={copyPassword}>Copy password</button>
                  </div>
                ) : null}
              </section>

              <section className="drawer-section">
                <h3 className="panel-title">2. Choose what they can do</h3>
                <p className="note">Admin can see every office and cannot change records or access.</p>
                <form className="access-search" onSubmit={search}>
                  <input
                    aria-label="Search the company directory"
                    placeholder="Search the company directory"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <button
                    className="solid icon-submit"
                    type="submit"
                    aria-label="Search the directory"
                    title="Search the directory"
                    disabled={busy || query.trim().length < 2}
                  >
                    <IconSearch />
                  </button>
                </form>
                {results ? (
                  <div className="person-list">
                    {results.map((person) => (
                      <button type="button" key={person.directoryObjectId} onClick={() => choose(person)}>
                        <span>{person.displayName}</span>
                        <small>{person.signInName}</small>
                      </button>
                    ))}
                    {results.length ? null : <p>No @intuitive.AI account matched. Add the sign-in name below.</p>}
                  </div>
                ) : null}
                <form className="access-form" onSubmit={save}>
                  <label>Name
                    <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} required />
                  </label>
                  <label>Sign-in name
                    <input
                      type="email"
                      placeholder="name@intuitive.AI"
                      value={form.signInName}
                      onChange={(event) => setForm({ ...form, signInName: event.target.value })}
                      required
                    />
                  </label>
                  <label>Role
                    <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                      {ROLES.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  {needsOffice ? (
                    <label>Office
                      <select value={form.officeId} onChange={(event) => setForm({ ...form, officeId: event.target.value })} required>
                        <option value="">Choose an office</option>
                        {offices.map((office) => (
                          <option key={office.id} value={office.id}>{office.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="muted">{form.role === "admin" ? "Admin can see every office, and cannot record or change access." : "Super Admin can see every office, add offices, and change access."}</p>
                  )}
                  <button className="solid" type="submit" disabled={busy}>Save access</button>
                </form>
              </section>
            </div>
          </aside>
        </>
      ) : null}
    </section>
  );
}
