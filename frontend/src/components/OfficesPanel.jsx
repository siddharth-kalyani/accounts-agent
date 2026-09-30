import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useMounted } from "../hooks.js";
import { IconCheck, IconClose, IconSearch } from "../icons.jsx";
import { PickMenu } from "./PickMenu.jsx";
import { EmptyState } from "./Illustration.jsx";
import { Skeleton } from "./Skeleton.jsx";

export function OfficesPanel({ offices, onChanged, onToast, onUndoable }) {
  const [people, setPeople] = useState([]);
  const [access, setAccess] = useState([]);
  const [name, setName] = useState("");
  // An office can have several Office Managers; the first chosen is listed first.
  const [personIds, setPersonIds] = useState([]);
  const [personQuery, setPersonQuery] = useState("");
  const [names, setNames] = useState({});
  const [assign, setAssign] = useState({});
  const [removed, setRemoved] = useState(() => new Set());
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();

  async function loadPeople() {
    const [directory, roster] = await Promise.all([api("/api/people"), api("/api/access")]);
    if (!mounted.current) return;
    setPeople(directory.people);
    setAccess(roster.people);
    setPeopleLoaded(true);
  }

  useEffect(() => {
    loadPeople().catch((err) => setError(err.message));
  }, []);

  const needle = personQuery.trim().toLowerCase();
  const choices = people.filter((person) => !needle || `${person.displayName} ${person.email}`.toLowerCase().includes(needle));
  const chosenPeople = personIds.map((id) => people.find((person) => person.id === id)).filter(Boolean);

  function togglePerson(id) {
    setPersonIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  function managers(officeId) {
    return access.flatMap((person) => (person.grants || [])
      .filter((grant) => grant.role === "office_manager" && grant.officeId === officeId && !removed.has(grant.id))
      .map((grant) => ({ ...grant, personId: person.id, displayName: person.displayName, email: person.email })));
  }

  async function addOffice(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api("/api/offices", { method: "POST", body: { name, managerIds: personIds } });
      setName("");
      setPersonIds([]);
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

  // Hidden at once; the removal is sent when the Undo toast closes.
  function removeManager(manager, office) {
    setError("");
    setRemoved((current) => new Set(current).add(manager.id));
    onUndoable({
      text: `Removed ${manager.displayName} as Office Manager at ${office.name}.`,
      commit: async ({ keepalive } = {}) => {
        await api(`/api/access/${manager.personId}/grants/${manager.id}`, { method: "DELETE", keepalive });
        if (keepalive) return;
        await loadPeople();
        await onChanged();
      },
      revert: () => {
        if (!mounted.current) return;
        setRemoved((current) => {
          const next = new Set(current);
          next.delete(manager.id);
          return next;
        });
      },
    });
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
          <span>
            Office Managers
            <span className="field-hint">{personIds.length ? ` · ${personIds.length} chosen` : " · choose one or more"}</span>
          </span>
          {chosenPeople.length ? (
            <div className="chosen-chips" aria-label="Chosen Office Managers">
              {chosenPeople.map((person) => (
                <span className="role-chip" key={person.id}>
                  {person.displayName}
                  <button type="button" aria-label={`Remove ${person.displayName}`} title={`Remove ${person.displayName}`} onClick={() => togglePerson(person.id)}>
                    <IconClose />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
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
              {!peopleLoaded && !error ? <Skeleton label="Loading people." rows={2} /> : null}
              {peopleLoaded && !people.length ? (
                <EmptyState art="people" className="compact" title="No one to choose yet">Invite someone from Access first.</EmptyState>
              ) : null}
              {choices.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={personIds.includes(person.id)}
                  onClick={() => togglePerson(person.id)}
                >
                  <span>{person.displayName}</span>
                  <small>{person.email}</small>
                  {personIds.includes(person.id) ? <span className="pick-check" aria-hidden="true"><IconCheck /></span> : null}
                </button>
              ))}
              {people.length > 0 && !choices.length ? <p>No person matches that search.</p> : null}
            </div>
          </div>
        </div>
        <button className="solid" type="submit" disabled={busy || !name.trim() || !personIds.length}>{busy ? "Saving…" : "Add office"}</button>
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
                        <button className="ghost small" type="button" onClick={() => removeManager(manager, office)}>Remove</button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="note">No Office Manager yet. Only a Super Admin can record here until one is added.</p>}
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
        {!offices.length ? (
          <EmptyState art="office" title="No office yet.">Add the first office above. It starts with Coffee, Milk, Sugar, Tea, and Sticks.</EmptyState>
        ) : null}
      </div>
    </section>
  );
}
