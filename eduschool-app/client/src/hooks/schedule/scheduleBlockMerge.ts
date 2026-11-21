import type { BlockVisibility, GMap, SC, SchedGroup, SchedStudent, TimeSlot } from '../../components/schedule/scheduleTypes';
import { DEFAULT_SLOTS } from './scheduleSlotUtils';
import { scKey } from './scheduleKeys';

// paidUntil (ISO) → "DD.MM.YYYY" for SchedStudent.pd; '' when unset.
export function fmtPaidUntil(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export interface ServerBlock {
  id: number;
  timeSlotId?: number | null;
  timeSlot?: { id: number; startTime: string; endTime: string; order: number } | null;
  startTime: string;
  endTime: string;
  days: number[];
  effectiveDays?: number[];
  level: string;
  chapter: number;
  maxStudents: number;
  type?: string;
  startDate: string | null;
  endDate: string | null;
  teacher: { id: number; firstName: string; lastName: string } | null;
  cabinet: { id: number; name: string; capacity: number } | null;
  // New: cohort group is the single source of truth
  studentGroupId?: number | null;
  status?: 'UPCOMING' | 'COMPLETED' | 'CANCELLED';
  studentGroup?: {
    id: number;
    name: string;
    level: string;
    chapter: number;
    status?: string;
    memberships: Array<{ bookIssued?: boolean; studentProfile: { id: number; chapter?: number; credits?: number; paidUntil?: string | null; notes?: string | null; isFrozen?: boolean; user: { firstName: string; lastName: string } } }>;
  } | null;
  // Backend truth-display fields (additive) — see server's classifyBlockVisibility().
  blockVisibility?: BlockVisibility;
  visibilityReason?: string;
  isScheduleActive?: boolean;
  isReadOnly?: boolean;
  conflictEligible?: boolean;
  sessionCountInRange?: number;
}

// Severity order used to pick one label for a merged grammar+club card when
// neither constituent block is active — higher index wins. Mirrors the bias
// of the existing blockStatus ternary (favor the still-actionable state).
const VISIBILITY_SEVERITY: BlockVisibility[] = [
  'OUT_OF_GRID', 'HISTORICAL', 'CLOSED_BY_END_DATE', 'COMPLETED', 'CANCELLED', 'SOFT_DELETED',
];

function pickVisibilityWinner(blocks: ServerBlock[]): ServerBlock | undefined {
  const active = blocks.find(b => b.isScheduleActive);
  if (active) return active;
  return blocks
    .filter(b => b.blockVisibility != null)
    .sort((a, b) => VISIBILITY_SEVERITY.indexOf(b.blockVisibility!) - VISIBILITY_SEVERITY.indexOf(a.blockVisibility!))[0];
}

export interface BuiltScheduleState {
  newG: GMap;
  newSC: SC;
  baseSlots: TimeSlot[];
  legacyDaysArr: number[];
  legacySlotIds: number[];
}

// Pure transform: server blocks → grid state (SchedGroup map + cell index + slots).
// Extracted out of useSchedule's loadFromServer so the merge/grouping logic
// (grammar+club pairing, legacy day/slot detection, student roster merge) can be
// unit-tested without mounting the hook.
export function buildScheduleStateFromBlocks(
  serverBlocks: ServerBlock[],
  dbSlots: TimeSlot[] | undefined,
  activeDays: number[] | undefined,
  currentActiveDays: number[],
): BuiltScheduleState {
  // Pre-compute legacy days: raw block days that are NOT in the configured activeDays.
  // These exist when school.activeDays was changed (e.g. Saturday removed) but blocks
  // still reference those days. Without this, groups on legacy days disappear from grid.
  const configuredDaySet = new Set(
    activeDays && activeDays.length > 0 ? activeDays : currentActiveDays
  );
  const allRawDays = serverBlocks.flatMap(b => b.days).filter(d => d >= 0 && d <= 6);
  const legacyDaysSet = new Set(allRawDays.filter(d => !configuredDaySet.has(d)));
  const legacyDaysArr = [...legacyDaysSet].sort((a, b) => a - b);

  // Build base slot list from DB slots; fall back to DEFAULT_SLOTS only when no DB data
  const baseSlots = dbSlots && dbSlots.length > 0
    ? [...dbSlots]
    : [...DEFAULT_SLOTS];
  let nextSid = Math.max(...baseSlots.map(sl => sl.id)) + 1;

  // Map by DB TimeSlot ID (primary) and by startTime-endTime key (legacy fallback)
  const slotKey = (s: string, e: string) => `${s}-${e}`;
  const slotIdMap = new Map<string, number>();
  baseSlots.forEach(sl => slotIdMap.set(slotKey(sl.s, sl.e), sl.id));

  // Группируем блоки: grammar+club одного слота одной StudentGroup — в одну пару.
  // Разные временные слоты одной группы → разные SchedGroup (не сливаем 08:00 и 11:20).
  // Любой блок с endDate (версионированный сплитом) получает уникальный ключ по дате закрытия,
  // чтобы старая и новая версия блока не сливались в один SchedGroup.
  // Условие: endDate != null — не зависит от того, прошлое это или будущее.
  const mergeKey = (b: ServerBlock) => {
    const isClosed = b.endDate != null;
    if (isClosed) {
      const closedDate = b.endDate!.slice(0, 10);
      const slotRef = b.timeSlotId != null ? b.timeSlotId : `${b.startTime}-${b.endTime}`;
      return b.studentGroupId
        ? `grp:${b.studentGroupId}:ts:${slotRef}:closed:${closedDate}`
        : `time:${b.startTime}|${b.endTime}|${b.level}:closed:${closedDate}`;
    }
    if (!b.studentGroupId) {
      // Include teacher identity so blocks from different teachers at the same
      // time+level don't collapse into a single row (hiding the later teacher).
      const teacherRef = b.teacher?.id ?? 'none';
      return `time:${b.startTime}|${b.endTime}|${b.level}:t${teacherRef}`;
    }
    const slotRef = b.timeSlotId != null ? b.timeSlotId : `${b.startTime}-${b.endTime}`;
    return `grp:${b.studentGroupId}:ts:${slotRef}`;
  };

  const byKey = new Map<string, ServerBlock[]>();
  for (const block of serverBlocks) {
    const k = mergeKey(block);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(block);
  }

  const newG: GMap = {};
  const newSC: SC = {};

  for (const blocks of byKey.values()) {
    const primary = blocks[0];
    const gid = primary.id;

    const grammars = blocks.filter(b => (b.type ?? 'GRAMMAR') !== 'SPEAKING_CLUB');
    const clubs    = blocks.filter(b => b.type === 'SPEAKING_CLUB');

    const grammar = grammars[0];
    const club = clubs[0];

    // Resolve slot ID
    let sid: number;
    if (primary.timeSlotId && baseSlots.some(sl => sl.id === primary.timeSlotId)) {
      sid = primary.timeSlotId;
    } else {
      const sk = slotKey(primary.startTime, primary.endTime);
      if (!slotIdMap.has(sk)) {
        slotIdMap.set(sk, nextSid);
        baseSlots.push({ id: nextSid, s: primary.startTime, e: primary.endTime });
        nextSid++;
      }
      sid = slotIdMap.get(sk)!;
    }

    // Используем синхронизированных учителей для групп
    const grammarTeacher = grammar?.teacher
      ? `${grammar.teacher.firstName} ${grammar.teacher.lastName}`.trim() : '—';
    const clubTeacher = club?.teacher
      ? `${club.teacher.firstName} ${club.teacher.lastName}`.trim() : '—';

    // Use effectiveDays (intersection with school.activeDays) for display.
    // Falls back to raw days for backward compat with old API responses.
    // effectiveDays = intersection of block.days with school.activeDays (from backend).
    // We also include legacy days (block.days that were excluded from activeDays) so
    // historical groups remain visible in the grid after a settings change.
    const grammarDays = [...new Set([
      ...grammars.flatMap(b => (b.effectiveDays != null ? b.effectiveDays : b.days)),
      ...grammars.flatMap(b => b.days.filter(d => legacyDaysSet.has(d))),
    ])].sort((a, b) => a - b);
    const clubDays = [...new Set([
      ...clubs.flatMap(b => (b.effectiveDays != null ? b.effectiveDays : b.days)),
      ...clubs.flatMap(b => b.days.filter(d => legacyDaysSet.has(d))),
    ])].sort((a, b) => a - b);

    // Объединяем студентов из обоих блоков и их групп без дубликатов
    const seenStu = new Set<number>();
    const stu: SchedStudent[] = [];
    for (const block of [grammar, club].filter(Boolean) as ServerBlock[]) {
      // Студенты из привязанной группы (GroupMembership — единственный источник правды)
      const groupMemberships = block.studentGroup?.memberships ?? [];
      for (const m of groupMemberships) {
        const st = m.studentProfile;
        if (!seenStu.has(st.id)) {
          seenStu.add(st.id);
          stu.push({
            id: st.id,
            n: `${st.user.firstName} ${st.user.lastName}`.trim(),
            ph: '', em: '', ch: st.chapter ?? primary.chapter,
            pd: fmtPaidUntil(st.paidUntil), cr: st.credits ?? 0,
            ta: null as null | 'pr' | 'ab',
            st: st.isFrozen ? 'ho' : 'ok', cm: st.notes ?? '', lt: 'all' as const, book: m.bookIssued ?? false,
          });
        }
      }
    }

    const grpType: SchedGroup['type'] = grammar && club ? 'regular' : club ? 'club' : 'regular';
    const visibilityWinner = pickVisibilityWinner(blocks);

    newG[String(gid)] = {
      id: gid,
      n: primary.cabinet?.name ?? '',
      lv: primary.studentGroup?.level || primary.level,
      cap: primary.cabinet?.capacity ?? Math.max(primary.maxStudents, club?.maxStudents ?? 0),
      tg: grammarTeacher,
      tk: clubTeacher,
      cc: primary.studentGroup?.chapter || primary.chapter,
      gta: null,
      stu,
      type: grpType,
      grammarDays,
      clubDays,
      tgd: [], tkd: [],
      linkedIds: club && grammar ? [club.id] : undefined,
      grammarBlockId: grammar?.id,
      clubBlockId: club?.id,
      startDate: (() => {
        const dates = blocks.map(b => b.startDate ? new Date(b.startDate).getTime() : null);
        const valid = dates.filter((d): d is number => d !== null);
        // Показываем блок с самой ранней даты начала среди всех связанных блоков
        return valid.length > 0 ? new Date(Math.min(...valid)).toISOString() : undefined;
      })(),
      endDate: primary.endDate ?? undefined,
      tgId: grammar?.teacher?.id ?? undefined,
      tkId: club?.teacher?.id ?? undefined,
      cabinetId: primary.cabinet?.id ?? undefined,
      studentGroupId: primary.studentGroupId ?? undefined,
      startTime: primary.startTime,
      endTime: primary.endTime,
      grammarStartTime: grammar?.startTime,
      grammarEndTime: grammar?.endTime,
      clubStartTime: club?.startTime,
      clubEndTime: club?.endTime,
      chapter: primary.studentGroup?.chapter ?? primary.chapter,
      maxStudents: primary.maxStudents,
      status: (primary.studentGroup?.status ?? club?.studentGroup?.status) as SchedGroup['status'],
      blockStatus: blocks.some(b => b.status === 'UPCOMING') ? 'UPCOMING'
        : blocks.some(b => b.status === 'CANCELLED') ? 'CANCELLED'
        : blocks.some(b => b.status === 'COMPLETED') ? 'COMPLETED'
        : undefined,
      // Any-active-wins: a still-live lesson type (grammar or club) keeps the merged
      // card actionable even if its paired type has closed. Only when neither
      // constituent is active does VISIBILITY_SEVERITY pick which label/reason shows.
      blockVisibility: visibilityWinner?.blockVisibility,
      visibilityReason: visibilityWinner?.visibilityReason,
      isScheduleActive: blocks.some(b => b.isScheduleActive),
      isReadOnly: blocks.length > 0 && !blocks.some(b => b.isScheduleActive),
      conflictEligible: blocks.some(b => b.conflictEligible),
      sessionCountInRange: blocks.some(b => b.sessionCountInRange != null)
        ? blocks.reduce((sum, b) => sum + (b.sessionCountInRange ?? 0), 0)
        : undefined,
    };

    // Map into cells: effective (active) days + legacy days (for historical visibility)
    const allDayIdxs = [...new Set([
      ...grammars.flatMap(b => [
        ...(b.effectiveDays != null ? b.effectiveDays : b.days),
        ...b.days.filter(d => legacyDaysSet.has(d)),
      ]),
      ...clubs.flatMap(b => [
        ...(b.effectiveDays != null ? b.effectiveDays : b.days),
        ...b.days.filter(d => legacyDaysSet.has(d)),
      ]),
    ])];
    for (const ci of allDayIdxs) {
      const cellKey = scKey(ci, sid);
      if (!newSC[cellKey]) newSC[cellKey] = [];
      if (!newSC[cellKey].includes(gid)) newSC[cellKey].push(gid);
    }
  }

  // Track slot IDs created dynamically (group time ≠ any configured slot)
  const configSlotIds = new Set(dbSlots?.map(sl => sl.id) ?? []);
  const legacySlotIds = baseSlots.filter(sl => !configSlotIds.has(sl.id)).map(sl => sl.id);

  return { newG, newSC, baseSlots, legacyDaysArr, legacySlotIds };
}

// Preserve in-session attendance marks across full reloads. The server payload
// knows nothing about attendance, so a plain replace would wipe every stu.ta —
// submitted statuses visibly flashed back to «Не отмечен» until GroupRow
// re-fetched. GroupRow stays the authority: it re-applies server truth on
// expand / day change (with an upfront reset when the day actually changed).
export function mergeAttendanceMarks(prev: GMap, newG: GMap): GMap {
  for (const key of Object.keys(newG)) {
    const pg = prev[key];
    if (!pg) continue;
    const prevTa = new Map(pg.stu.map(s => [s.id, s.ta]));
    const ng = newG[key];
    ng.stu = ng.stu.map(s => {
      const ta = prevTa.get(s.id);
      return ta ? { ...s, ta } : s;
    });
    ng.gta = pg.gta;
  }
  return newG;
}
