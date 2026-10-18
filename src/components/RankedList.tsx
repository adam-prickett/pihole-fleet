import type {ReactNode} from 'react';
import type {RankedItem} from '../lib/aggregate.js';
import {fmtMs, fmtNumber} from '../lib/format.js';
import {Panel} from './Panel.js';

/** An extra column, e.g. average response time for upstreams. */
export interface ExtraColumn {
  label: string;
  render: (item: RankedItem) => ReactNode;
}

interface RankedListProps {
  title: string;
  meta?: string;
  items: RankedItem[];
  barColor: string;
  limit?: number;
  instanceNames: Record<string, string>;
  extra?: ExtraColumn;
  nameHeader?: string;
  className?: string;
  empty?: string;
}

/**
 * Dense top-N table with an inline magnitude bar. Hovering a row shows the
 * per-instance breakdown so you can see which Pi-hole a domain/client hits.
 */
export function RankedList({
  title,
  meta,
  items,
  barColor,
  limit = 10,
  instanceNames,
  extra,
  nameHeader = 'Name',
  className = 'span-4',
  empty = 'No data',
}: RankedListProps) {
  const rows = items.slice(0, limit);
  const max = rows[0]?.count || 1;
  const sum = items.reduce((a, r) => a + r.count, 0) || 1;

  return (
    <Panel title={title} meta={meta} className={className} flush>
      {rows.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <table className="grid-table ranked">
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>{nameHeader}</th>
              {extra && <th className="num">{extra.label}</th>}
              <th className="num">Count</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const breakdown = r.by
                ? Object.entries(r.by)
                    .map(
                      ([id, n]) =>
                        `${instanceNames[id] ?? id}: ${fmtNumber(n)}`,
                    )
                    .join('\n')
                : '';
              return (
                <tr key={r.key} title={`${r.label}\n${breakdown}`}>
                  <td className="rank mono dim">{i + 1}</td>
                  <td className="ranked-name">
                    <span
                      className="ranked-bar"
                      style={{
                        width: `${(r.count / max) * 100}%`,
                        background: barColor,
                      }}
                    />
                    <span className="ranked-label">{r.label}</span>
                  </td>
                  {extra && <td className="num mono dim">{extra.render(r)}</td>}
                  <td className="num mono">{fmtNumber(r.count)}</td>
                  <td className="num mono dim">
                    {((r.count / sum) * 100).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export const upstreamExtra: ExtraColumn = {
  label: 'Avg resp',
  render: r => fmtMs(r.responseMs),
};
