import { Area, AreaChart, ResponsiveContainer, YAxis } from 'recharts';
import { fmtCompact, fmtNumber } from '../lib/format.js';

function Spark({ data, dataKey, color }) {
  if (!data || data.length < 2) return <div className="stat-spark" />;
  return (
    <div className="stat-spark" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <YAxis hide domain={[0, 'dataMax']} />
          <Area type="linear" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.14} isAnimationActive={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Stat({ label, value, unit, detail, title, spark }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      <div className="stat-detail">{detail}</div>
      {spark}
    </div>
  );
}

const daysAgo = (unix) => (unix ? Math.floor((Date.now() / 1000 - unix) / 86400) : null);

export default function StatPanels({ agg }) {
  const { totals, history } = agg;
  const gravityAge = daysAgo(totals.gravityOldest);
  return (
    <section className="stats" aria-label="Fleet metrics">
      <Stat
        label="Queries · 24h"
        value={fmtCompact(totals.total)}
        detail={<><span className="mono">{totals.frequency.toFixed(1)}</span> q/s current</>}
        title={`${fmtNumber(totals.total)} queries`}
        spark={<Spark data={history} dataKey="total" color="var(--allowed)" />}
      />
      <Stat
        label="Blocked · 24h"
        value={fmtCompact(totals.blocked)}
        detail="by gravity, regex & deny lists"
        title={`${fmtNumber(totals.blocked)} queries blocked`}
        spark={<Spark data={history} dataKey="blocked" color="var(--blocked)" />}
      />
      <Stat
        label="Block rate"
        value={totals.percentBlocked.toFixed(1)}
        unit="%"
        detail="of all queries"
        spark={<Spark data={history} dataKey="pct" color="var(--blocked)" />}
      />
      <Stat
        label="Cache hit rate"
        value={totals.percentCached.toFixed(1)}
        unit="%"
        detail={<><span className="mono">{fmtCompact(totals.forwarded)}</span> forwarded upstream</>}
      />
      <Stat
        label="Active clients"
        value={fmtNumber(totals.activeClients)}
        detail="summed across instances"
      />
      <Stat
        label="Blocklist domains"
        value={fmtCompact(totals.gravityDomains)}
        detail={gravityAge == null ? 'largest list in scope' : `oldest gravity update ${gravityAge}d ago`}
        title={fmtNumber(totals.gravityDomains)}
      />
    </section>
  );
}
