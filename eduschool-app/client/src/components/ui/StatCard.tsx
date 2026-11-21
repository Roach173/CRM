import { type ReactNode } from 'react';
import { Link } from 'react-router';

interface StatCardProps {
  icon?: string | ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  /** Tailwind text-color class for the value, e.g. "text-primary". Defaults to text-textPrimary. */
  color?: string;
  className?: string;
  to?: string;
}

// Visual design mirrors the Finance dashboard StatTile (bordered surfaceLowest box,
// micro uppercase label, faded left icon). Value size bumped to text-2xl for KPI prominence.
export function StatCard({ icon, label, value, sub, color, className, to }: StatCardProps) {
  const content = (
    <div
      className={`bg-surfaceLowest border border-border rounded px-5 py-4 flex items-start gap-3 ${
        to ? 'hover:border-primary/40 transition-colors' : ''
      } ${className || ''}`}
    >
      {icon && <div className="flex-shrink-0 mt-0.5 opacity-40">{icon}</div>}
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase text-textSecondary mb-1">{label}</p>
        <p className={`font-bold text-2xl leading-tight break-words ${color ?? 'text-textPrimary'}`}>{value}</p>
        {sub && <p className="text-[10px] text-textSecondary/60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
  return to ? <Link to={to} className="block">{content}</Link> : content;
}
