// Small line illustrations for empty and failed states. Colours come from the
// theme tokens through CSS classes (see "Illustrations" in styles.css), so they
// follow light and dark mode. The red accent is kept to one small mark.
const ART = {
  people: (
    <>
      <rect className="art-card" x="18" y="14" width="84" height="56" rx="6" />
      <circle className="art-fill" cx="44" cy="36" r="9" />
      <path className="art-line" d="M30 58c2-8 8-12 14-12s12 4 14 12" />
      <path className="art-soft" d="M68 32h24M68 42h18M68 52h22" />
      <circle className="art-accent" cx="100" cy="16" r="5" />
    </>
  ),
  box: (
    <>
      <path className="art-card" d="M60 12 96 30v30L60 78 24 60V30Z" />
      <path className="art-line" d="M24 30 60 48l36-18M60 48v30" />
      <path className="art-soft" d="M42 21l36 18" />
      <circle className="art-accent" cx="98" cy="18" r="5" />
    </>
  ),
  receipt: (
    <>
      <path className="art-card" d="M38 10h44v64l-7-5-7 5-7-5-8 5-7-5-8 5Z" />
      <path className="art-soft" d="M47 26h26M47 36h26M47 46h16" />
      <path className="art-line" d="M47 58h26" />
      <circle className="art-accent" cx="88" cy="16" r="5" />
    </>
  ),
  activity: (
    <>
      <rect className="art-card" x="22" y="14" width="76" height="56" rx="6" />
      <circle className="art-fill" cx="42" cy="32" r="5" />
      <circle className="art-fill" cx="42" cy="52" r="5" />
      <path className="art-soft" d="M54 32h32M54 52h24" />
      <path className="art-line" d="M42 37v10" />
      <circle className="art-accent" cx="98" cy="16" r="5" />
    </>
  ),
  office: (
    <>
      <path className="art-card" d="M28 72V28l32-14 32 14v44Z" />
      <path className="art-line" d="M28 40h64M50 72V54h20v18" />
      <path className="art-soft" d="M40 30h8M72 30h8" />
      <circle className="art-accent" cx="96" cy="18" r="5" />
    </>
  ),
  offline: (
    <>
      <path className="art-card" d="M36 60h50a14 14 0 0 0 0-28 20 20 0 0 0-38-4 16 16 0 0 0-12 32Z" />
      <path className="art-line" d="M52 44l16 12M68 44 52 56" />
      <circle className="art-accent" cx="94" cy="20" r="5" />
    </>
  ),
};

export function Illustration({ name = "box", className = "" }) {
  return (
    <svg className={`art ${className}`.trim()} viewBox="0 0 120 84" width="120" height="84" aria-hidden="true" focusable="false">
      {ART[name] || ART.box}
    </svg>
  );
}

// One empty state for the app: a picture, a short title, what to do next.
export function EmptyState({ art = "box", title, children, actions, className = "" }) {
  return (
    <div className={`empty-state with-art ${className}`.trim()}>
      <Illustration name={art} />
      <div className="empty-copy">
        <p className="empty-title">{title}</p>
        {children ? <p className="note">{children}</p> : null}
        {actions ? <div className="row-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
