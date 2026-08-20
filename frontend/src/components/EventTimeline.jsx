import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { useMemo } from "react";

function formatTime(isoString) {
  // Extract HH:mm:ss from ISO timestamp
  return isoString.slice(11, 19);
}

function pivotTimeline(records) {
  const map = new Map();

  records.forEach((r) => {
    if (r.source !== "GOES11_MAG" && r.source !== "GOES11_EP8") return;
    const t = formatTime(r.timestamp);
    if (!map.has(t)) map.set(t, { time: t });
    const entry = map.get(t);
    if (r.source === "GOES11_MAG") entry.mag = parseFloat(r.value);
    if (r.source === "GOES11_EP8") entry.eFlux = parseFloat(r.value);
  });

  return Array.from(map.values()).sort((a, b) => a.time.localeCompare(b.time));
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-xs font-mono">
      <p className="text-slate-300 mb-1">{label} UTC</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.value != null ? p.value.toFixed(3) : "—"}
        </p>
      ))}
    </div>
  );
};

export default function EventTimeline({ timelineData, anchorTimestamp }) {
  const chartData = useMemo(() => pivotTimeline(timelineData ?? []), [timelineData]);
  const anomalyTime = anchorTimestamp ? formatTime(anchorTimestamp) : "09:48:00";

  return (
    <div className="bg-slate-900 rounded-xl p-4 border border-slate-700">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-mono text-sm font-semibold text-slate-200 uppercase tracking-wider">
          GOES-11 Environmental Data — 08:00–11:00 UTC
        </h2>
        <span className="text-xs font-mono text-slate-500">2010-04-05</span>
      </div>

      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 60, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis
            dataKey="time"
            tick={{ fill: "#94a3b8", fontSize: 11, fontFamily: "monospace" }}
            interval={14}
            stroke="#334155"
          />
          {/* Left Y — magnetic field */}
          <YAxis
            yAxisId="left"
            tick={{ fill: "#67e8f9", fontSize: 11, fontFamily: "monospace" }}
            stroke="#334155"
            label={{ value: "B-field (nT)", angle: -90, position: "insideLeft", fill: "#67e8f9", fontSize: 11, dy: 40 }}
          />
          {/* Right Y — electron flux (log scale) */}
          <YAxis
            yAxisId="right"
            orientation="right"
            scale="log"
            domain={["auto", "auto"]}
            tick={{ fill: "#fbbf24", fontSize: 11, fontFamily: "monospace" }}
            stroke="#334155"
            label={{ value: "e-flux (log)", angle: 90, position: "insideRight", fill: "#fbbf24", fontSize: 11, dy: -40 }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 11, fontFamily: "monospace", color: "#94a3b8" }}
          />

          <ReferenceLine
            yAxisId="left"
            x={anomalyTime}
            stroke="#ef4444"
            strokeWidth={2}
            strokeDasharray="6 3"
            label={{ value: "Galaxy 15 Anomaly", position: "top", fill: "#ef4444", fontSize: 10, fontFamily: "monospace" }}
          />

          <Line
            yAxisId="left"
            type="monotone"
            dataKey="mag"
            name="MAG B-field (nT)"
            stroke="#67e8f9"
            dot={false}
            strokeWidth={1.5}
            connectNulls
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="eFlux"
            name="EP8 e-flux"
            stroke="#fbbf24"
            dot={false}
            strokeWidth={1.5}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
