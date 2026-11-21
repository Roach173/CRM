import { DAYS_SHORT } from './scheduleTypes';
import { C } from './scheduleTheme';

interface DaySelectorProps {
  value: number[];
  onChange: (days: number[]) => void;
  activeDays: number[];
  variant: 'grammar' | 'club';
}

export default function DaySelector({ value, onChange, activeDays, variant }: DaySelectorProps) {
  const activeColor = variant === 'grammar' ? C.green : C.blue;

  function toggle(i: number) {
    onChange(value.includes(i) ? value.filter(x => x !== i) : [...value, i].sort((a, b) => a - b));
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {DAYS_SHORT.map((d, i) => {
        if (!activeDays.includes(i)) return null;
        const active = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            className={active ? 'sch-day' : 'sch-day sch-day--idle'}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 700,
              background: active ? activeColor : C.bg,
              color: active ? '#fff' : C.mid,
              border: `1.5px solid ${active ? activeColor : C.border}`,
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.15)' : undefined,
            }}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}
