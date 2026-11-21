import type { TimeSlot } from '../../components/schedule/scheduleTypes';

// ─── Default slots ────────────────────────────────────────────────────────────

export const DEFAULT_SLOTS: TimeSlot[] = [
  { id:1, s:'08:20', e:'09:40' },
  { id:2, s:'09:40', e:'11:00' },
  { id:3, s:'11:00', e:'12:20' },
  { id:4, s:'13:40', e:'15:00' },
  { id:5, s:'15:00', e:'16:20' },
  { id:6, s:'16:20', e:'17:40' },
  { id:7, s:'17:40', e:'19:00' },
  { id:8, s:'19:00', e:'20:20' },
];

// ─── Slot generation from CRM schedule settings ───────────────────────────────

export function generateSlotsFromSettings(
  workStart: string,
  workEnd: string,
  slotDuration: number,
): TimeSlot[] {
  const parse = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

  const startMin = parse(workStart);
  const endMin   = parse(workEnd);
  const dur      = Math.max(30, Math.min(240, slotDuration));

  if (startMin >= endMin || dur <= 0) return DEFAULT_SLOTS;

  const slots: TimeSlot[] = [];
  let id = 1;
  let cur = startMin;
  while (cur + dur <= endMin) {
    slots.push({ id, s: fmt(cur), e: fmt(cur + dur) });
    id++;
    cur += dur;
  }
  return slots.length ? slots : DEFAULT_SLOTS;
}
