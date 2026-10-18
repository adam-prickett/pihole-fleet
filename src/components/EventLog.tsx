import type {DashboardEvent, Severity} from '../../server/types.js';
import {Panel, StatusLabel} from './Panel.js';

const SEVERITY: Record<Severity, string> = {
  good: 'OK',
  warning: 'WARN',
  serious: 'ERROR',
  critical: 'CRIT',
};
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface EventLogProps {
  events: DashboardEvent[];
  instanceNames: Record<string, string>;
  /** Only show events for these instances (null = all). */
  focusedIds: Set<string> | null;
  className?: string;
}

export function EventLog({
  events,
  instanceNames,
  focusedIds,
  className,
}: EventLogProps) {
  const rows = focusedIds
    ? events.filter(e => focusedIds.has(e.instanceId))
    : events;
  return (
    <Panel title="Events" meta="since server start" className={className} flush>
      {rows.length === 0 ? (
        <div className="empty">No events</div>
      ) : (
        <ol className="events">
          {rows.map(e => (
            <li key={e.id}>
              <span className="mono dim">{timeFmt.format(e.t)}</span>
              <StatusLabel status={e.severity}>
                {SEVERITY[e.severity]}
              </StatusLabel>
              <span className="event-body">
                <span className="event-instance">
                  {instanceNames[e.instanceId] ??
                    e.instanceName ??
                    e.instanceId}
                </span>
                <span className="event-msg" title={e.message}>
                  {e.message}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
