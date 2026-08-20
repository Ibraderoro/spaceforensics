import { Satellite, Activity } from "lucide-react";

const STATUS_SENSORS = [
  { label: "GOES-11 MAG", key: "mag" },
  { label: "GOES-11 EP8", key: "ep8" },
  { label: "EPHEMERIS",   key: "eph" },
];

export default function Header({ caseMeta }) {
  const asset = caseMeta?.target_asset;

  return (
    <header className="sticky top-0 z-50 bg-slate-900 border-b border-slate-700">
      <div className="max-w-screen-2xl mx-auto px-6 py-3 flex items-center justify-between gap-4">

        {/* Left — brand */}
        <div className="flex items-center gap-3 min-w-0">
          <Satellite className="w-6 h-6 text-cyan-400 shrink-0" />
          <span className="font-mono text-lg font-bold tracking-widest text-slate-100 uppercase truncate">
            SpaceForensics
          </span>
        </div>

        {/* Center — case identity */}
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
          </span>
          <span className="font-mono text-sm text-amber-300 tracking-wide">
            {asset ? `${asset.name} — ${asset.orbit_type} ${asset.longitude_deg_west}° W` : "Loading…"}
          </span>
        </div>

        {/* Right — sensor status + case selector */}
        <div className="flex items-center gap-3">
          {STATUS_SENSORS.map((s) => (
            <div key={s.key} className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-green-400">
              <Activity className="w-3 h-3" />
              <span>{s.label}</span>
              <span className="text-green-500">✓</span>
            </div>
          ))}
          <select
            className="ml-4 bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500"
            defaultValue="galaxy-15"
          >
            <option value="galaxy-15">Galaxy 15 — Apr 2010</option>
          </select>
        </div>

      </div>
    </header>
  );
}
