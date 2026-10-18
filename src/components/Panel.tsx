import type {ReactNode} from 'react';

/** A status colour; always shown with a text label. */
export type Status = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';

interface PanelProps {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
  /** Remove the body padding (for tables and lists). */
  flush?: boolean;
}

/** Standard panel chrome: compact title bar with optional meta text and actions. */
export function Panel({
  title,
  meta,
  actions,
  className = '',
  children,
  flush = false,
}: PanelProps) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {meta && <span className="panel-meta">{meta}</span>}
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>
        {children}
      </div>
    </section>
  );
}

/** Status LED + text label. Status colour never stands alone. */
export function StatusLabel({
  status,
  children,
}: {
  status: Status;
  children?: ReactNode;
}) {
  return (
    <span className={`status status-${status}`}>
      <span className="led" aria-hidden="true" />
      {children}
    </span>
  );
}
