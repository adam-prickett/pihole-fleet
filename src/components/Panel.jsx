/** Standard panel chrome: compact title bar with optional meta text and actions. */
export default function Panel({ title, meta, actions, className = '', children, flush = false }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {meta && <span className="panel-meta">{meta}</span>}
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

/** Status LED + text label. Status colour never stands alone. */
export function StatusLabel({ status, children }) {
  return (
    <span className={`status status-${status}`}>
      <span className="led" aria-hidden="true" />
      {children}
    </span>
  );
}
