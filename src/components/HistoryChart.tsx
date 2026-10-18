import {useState} from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {InstanceState} from '../../server/types.js';
import type {HistoryRow} from '../lib/aggregate.js';
import {fmtCompact, fmtHM, fmtNumber} from '../lib/format.js';
import {Panel} from './Panel.js';

type Mode = 'outcome' | 'instance';

interface TooltipEntry {
  dataKey?: unknown;
  name?: unknown;
  value?: unknown;
  color?: string;
}

/** Props Recharts injects into a custom tooltip, plus series display names. */
interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: number;
  names: Record<string, string>;
}

interface LegendItem {
  key: string;
  label: string;
  color: string;
}

const AXIS = {
  stroke: 'var(--axis)',
  tick: {fill: 'var(--text-muted)', fontSize: 11},
  tickLine: false,
};

function ChartTooltip({active, payload, label, names}: ChartTooltipProps) {
  if (!active || !payload?.length || label === undefined) return null;
  const total = payload.reduce((a, p) => a + Number(p.value ?? 0), 0);
  return (
    <div className="chart-tooltip">
      <div className="tooltip-title mono">
        {fmtHM(label)}–{fmtHM(label + 600)}
      </div>
      {[...payload].reverse().map(p => (
        <div className="tooltip-row" key={String(p.dataKey)}>
          <span className="swatch" style={{background: p.color}} />
          <span className="tooltip-name">
            {names[String(p.dataKey)] ?? String(p.name)}
          </span>
          <span className="tooltip-value mono">
            {fmtNumber(Number(p.value))}
          </span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="tooltip-row tooltip-total">
          <span />
          <span className="tooltip-name">Total</span>
          <span className="tooltip-value mono">{fmtNumber(total)}</span>
        </div>
      )}
    </div>
  );
}

function Legend({items}: {items: LegendItem[]}) {
  return (
    <ul className="legend">
      {items.map(it => (
        <li key={it.key}>
          <span className="swatch" style={{background: it.color}} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

interface HistoryChartProps {
  history: HistoryRow[];
  instances: InstanceState[];
  colorOf: (id: string) => string;
  className?: string;
}

export function HistoryChart({
  history,
  instances,
  colorOf,
  className,
}: HistoryChartProps) {
  const [mode, setMode] = useState<Mode>('outcome');
  const instanceNames = Object.fromEntries(instances.map(i => [i.id, i.name]));
  const names: Record<string, string> =
    mode === 'outcome'
      ? {allowed: 'Allowed', blocked: 'Blocked'}
      : instanceNames;
  const legend: LegendItem[] =
    mode === 'outcome'
      ? [
          {key: 'allowed', label: 'Allowed', color: 'var(--allowed)'},
          {key: 'blocked', label: 'Blocked', color: 'var(--blocked)'},
        ]
      : instances.map(i => ({key: i.id, label: i.name, color: colorOf(i.id)}));

  return (
    <Panel
      title="Query volume"
      meta="last 24h · 10 min buckets"
      className={className}
      actions={
        <div className="segmented" role="tablist" aria-label="Breakdown">
          <button
            role="tab"
            aria-selected={mode === 'outcome'}
            onClick={() => setMode('outcome')}
          >
            Outcome
          </button>
          <button
            role="tab"
            aria-selected={mode === 'instance'}
            onClick={() => setMode('instance')}
          >
            Instance
          </button>
        </div>
      }
    >
      {history.length === 0 ? (
        <div className="empty">No history yet</div>
      ) : (
        <>
          <Legend items={legend} />
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              {mode === 'outcome' ? (
                <BarChart
                  data={history}
                  barCategoryGap={1}
                  margin={{top: 4, right: 4, bottom: 0, left: 0}}
                >
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--grid)"
                    strokeDasharray="2 3"
                  />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(t: number) => fmtHM(t)}
                    minTickGap={48}
                    {...AXIS}
                  />
                  <YAxis
                    tickFormatter={(n: number) => fmtCompact(n)}
                    width={44}
                    axisLine={false}
                    {...AXIS}
                  />
                  <Tooltip
                    content={<ChartTooltip names={names} />}
                    cursor={{fill: 'var(--hover-wash)'}}
                    isAnimationActive={false}
                  />
                  <Bar
                    dataKey="allowed"
                    stackId="q"
                    fill="var(--allowed)"
                    stroke="var(--panel)"
                    strokeWidth={1}
                    isAnimationActive={false}
                  />
                  <Bar
                    dataKey="blocked"
                    stackId="q"
                    fill="var(--blocked)"
                    stroke="var(--panel)"
                    strokeWidth={1}
                    isAnimationActive={false}
                  />
                </BarChart>
              ) : (
                <LineChart
                  data={history}
                  margin={{top: 4, right: 4, bottom: 0, left: 0}}
                >
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--grid)"
                    strokeDasharray="2 3"
                  />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(t: number) => fmtHM(t)}
                    minTickGap={48}
                    {...AXIS}
                  />
                  <YAxis
                    tickFormatter={(n: number) => fmtCompact(n)}
                    width={44}
                    axisLine={false}
                    {...AXIS}
                  />
                  <Tooltip
                    content={<ChartTooltip names={names} />}
                    cursor={{stroke: 'var(--axis)'}}
                    isAnimationActive={false}
                  />
                  {instances.map(inst => (
                    <Line
                      key={inst.id}
                      dataKey={inst.id}
                      stroke={colorOf(inst.id)}
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{
                        r: 3.5,
                        stroke: 'var(--panel)',
                        strokeWidth: 2,
                      }}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Panel>
  );
}
