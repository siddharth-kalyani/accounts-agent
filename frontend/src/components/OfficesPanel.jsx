import { useEffect, useState } from "react";
import { api } from "../api.js";
import { IconSearch } from "../icons.jsx";
import { PickMenu } from "./PickMenu.jsx";

export function OfficesPanel({ offices, onChanged, onToast }) {
  const [people, setPeople] = useState([]);
  const [access, setAccess] = useState([]);
  const [name, setName] = useState("");
  const [personId, setPersonId] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [names, setNames] = useState({});
  const [assign, setAssign] = useState({});
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadPeople() {
    const [directory, roster] = await Promise.all([api("/api/people"), api("/api/access")]);
    setPeople(directory.people);
    setAccess(roster.people);
  }

  useEffect(() => {
    loadPeople().catch((err) => setError(err.message));
  }, []);

  const needle = personQuery.trim().toLowerCase();
  const choices = people.filter((person) => !needle || `${person.displayName} ${person.email}`.toLowerCase().includes(needle));

  function managers(officeId) {
    return access.flatMap((person) => (person.grants || [])
      .filter((grant) => grant.role === "office_manager" && grant.officeId === officeId)
      .map((grant) => ({ ...grant, personId: person.id, displayName: person.displayName, email: person.email })));
  }

  async function addOffice(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api("/api/offices", { method: "POST", body: { name, managerId: personId } });
      setName("");
      setPersonId("");
      setPersonQuery("");
      await onChanged(created);
      await loadPeople();
      onToast?.(`Added ${created.name}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function rename(office) {
    const next = (names[office.id] ?? office.name).trim();
    if (!next || next === office.name) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api(`/api/offices/${office.id}`, { method: "PATCH", body: { name: next } });
      setNames((current) => ({ ...current, [office.id]: saved.name }));
      await onChanged(saved);
      onToast?.(`Renamed the office to ${saved.name}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function assignManager(officeId) {
    const chosen = assign[officeId];
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api(`/api/offices/${officeId}/manager`, { method: "POST", body: { personId: chosen } });
      setAssign((current) => ({ ...current, [officeId]: "" }));
      await loadPeople();
      await onChanged();
      onToast?.(`${saved.displayName} is an Office Manager there.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeManager() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/access/${pending.personId}/grants/${pending.grantId}`, { method: "DELETE" });
      setPending(null);
      await loadPeople();
      await onChanged();
      onToast?.("Office Manager removed.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Offices</h2>
      </div>
      <p className="lede">Add an office, rename it, or choose who records for it. A new office starts with Coffee, Milk, Sugar, Tea, and Sticks.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <form className="office-form panel" onSubmit={addOffice}>
        <h3 className="panel-title">Add an office</h3>
        <label className="field">Office name
          <input value={name} maxLength={80} placeholder="For example, Pune" onChange={(event) => setName(event.target.value)} required />
        </label>
        <div className="field">
          <span>Office Manager</span>
          <div className="pick-list">
            <span className="search-field">
              <IconSearch />
              <input
                value={personQuery}
                placeholder="Search people"
                aria-label="Search people"
                onChange={(event) => setPersonQuery(event.target.value)}
              />
            </span>
            <div className="person-list">
              {people.length === 0 && !error ? <p>Loading people.</p> : null}
              {choices.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={person.id === personId}
                  onClick={() => setPersonId(person.id)}
                >
                  <span>{person.displayName}</span>
                  <small>{person.email}</small>
                </button>
              ))}
              {people.length > 0 && !choices.length ? <p>No person matches that search.</p> : null}
            </div>
          </div>
        </div>
        <button className="solid" type="submit" disabled={busy || !name.trim() || !personId}>{busy ? "Saving…" : "Add office"}</button>
      </form>

      <div className="office-list">
        {offices.map((office) => {
          const current = managers(office.id);
          const taken = new Set(current.map((manager) => manager.personId));
          const draft = names[office.id] ?? office.name;
          const available = people
            .filter((person) => !taken.has(person.id))
            .map((person) => ({ value: person.id, label: person.displayName, detail: person.email }));
          return (
            <article className="office-row panel" key={office.id}>
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename(office);
                }}
              >
                <label className="field">Name
                  <input
                    value={draft}
                    maxLength={80}
                    aria-label={`Name for ${office.name}`}
                    onChange={(event) => setNames((currentNames) => ({ ...currentNames, [office.id]: event.target.value }))}
                  />
                </label>
                <button className="ghost" type="submit" disabled={busy || !draft.trim() || draft.trim() === office.name}>Rename</button>
              </form>
              <div className="office-managers">
                <p className="panel-label">Office Managers</p>
                {current.length ? (
                  <ul className="manager-list">
                    {current.map((manager) => (
                      <li className="manager-line" key={manager.id}>
                        <span>
                          <strong>{manager.displayName}</strong>
                          <small>{manager.email}</small>
                        </span>
                        <button className="ghost small" type="button" onClick={() => setPending(manager)}>Remove</button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="note">No Office Manager yet.</p>}
                {pending && current.some((manager) => manager.id === pending.id) ? (
                  <div className="confirm-card">
                    <p>Remove {pending.displayName} as Office Manager at {office.name}?</p>
                    <div className="row-actions">
                      <button className="solid" type="button" disabled={busy} onClick={removeManager}>Remove manager</button>
                      <button className="ghost" type="button" onClick={() => setPending(null)}>Keep</button>
                    </div>
                  </div>
                ) : null}
                <div className="inline-form">
                  <div className="field">
                    <span>Add an Office Manager</span>
                    <PickMenu
                      options={available}
                      value={assign[office.id] || ""}
                      onChange={(chosen) => setAssign((currentAssign) => ({ ...currentAssign, [office.id]: chosen }))}
                      label={`Add an Office Manager at ${office.name}`}
                      placeholder={available.length ? "Choose a person" : "Everyone is already here"}
                      searchLabel="Search people"
                      emptyText="No person matches that search."
                      disabled={!available.length}
                    />
                  </div>
                  <button className="ghost" type="button" disabled={busy || !assign[office.id]} onClick={() => assignManager(office.id)}>Assign</button>
                </div>
              </div>
            </article>
          );
        })}
        {!offices.length ? <p className="note">No office yet.</p> : null}
      </div>
    </section>
  );
}
