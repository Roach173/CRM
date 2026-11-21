import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'react-hot-toast';
import api from '../lib/api';
import { useAuth } from './useAuth';
import type {
  TimeSlot, SchedGroup, SchedStudent, SC, GMap, MakeupSessionSummary, WeekSessionMeta,
} from '../components/schedule/scheduleTypes';
import { lessonBlockIdForDay } from '../components/schedule/scheduleTypes';
import { scKey, sessionKey } from './schedule/scheduleKeys';
import {
  getMonday, weekKey, weekDates, weekLabel, addWeeks, dateKey, formatLocalIso,
} from './schedule/scheduleDateUtils';
import { ls, ss } from './schedule/scheduleStorage';
import { generateSlotsFromSettings } from './schedule/scheduleSlotUtils';
import {
  shouldShowGroupForDate, slotMatchesLesson, lessonMapsToAnySlot, lessonCandidatesForCell,
} from './schedule/scheduleSelectors';
import type { CellLessonCandidate } from './schedule/scheduleSelectors';
import { buildWeekSessionMaps } from './schedule/scheduleSessionNormalizers';
import type { RawWeekSession } from './schedule/scheduleSessionNormalizers';
import { buildScheduleStateFromBlocks, mergeAttendanceMarks } from './schedule/scheduleBlockMerge';
import type { ServerBlock } from './schedule/scheduleBlockMerge';

export type { TimeSlot, SchedGroup, SchedStudent, SC, GMap, MakeupSessionSummary, WeekSessionMeta };
export { DAYS_SHORT, DAYS_FULL, LEVELS } from '../components/schedule/scheduleTypes';

// paidUntil (ISO) → "DD.MM.YYYY" for SchedStudent.pd; '' when unset.
export function fmtPaidUntil(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export {
  getMonday, weekKey, weekDates, weekLabel, addWeeks, dateKey, formatLocalIso,
  generateSlotsFromSettings,
};

// ─── localStorage keys (UI preferences only — no business data) ───────────────

const K = {
  zoom:       'bios_sched_zoom',
  cellColors: 'bios_cell_colors',
  groupColors:'bios_group_colors',
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSchedule() {
  const { user } = useAuth();
  const isAdminRole = user?.role === 'OWNER' || user?.role === 'ADMIN';

  // Core state — always comes from server
  const [G, setG] = useState<GMap>({});
  const [SC, setSC] = useState<SC>({});
  // getGroupsInCell reads G through this ref so its identity does NOT change on
  // per-student edits (attendance/book toggles). Grid-level useMemo caches keyed
  // on getGroupsInCell (WeekGrid/RoomsView/TeacherView/GroupView) therefore skip
  // recomputing the whole grid on every click — chips never render ta/book.
  // structureTick bumps the identity for G changes the grid DOES show
  // (roster size, chapter); full reloads already invalidate via the new SC ref.
  const GRef = useRef<GMap>(G);
  GRef.current = G;
  const [structureTick, setStructureTick] = useState(0);
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [aDays, setADays] = useState<number[]>([]);
  // Ref keeps aDays current inside loadFromServer without adding it to deps (prevents infinite loops)
  const aDaysRef = useRef(aDays);
  aDaysRef.current = aDays;
  const [legacyDays, setLegacyDays] = useState<number[]>([]);
  const [legacySlotIds, setLegacySlotIds] = useState<number[]>([]);
  // Stable map of slotTime→realDbId, populated once by loadFromServer.
  // applySchedulePolicy reads from this ref (never from mutable `prev` state)
  // so historical-week navigation cannot poison slot IDs for subsequent weeks.
  const dbSlotIdMapRef = useRef<Map<string, number>>(new Map());
  // All raw block days seen in the last loadFromServer call.
  // Read by applySchedulePolicy to recompute legacyDays for the viewed week.
  const blockDaysRef = useRef<number[]>([]);
  const [zoom, setZoom] = useState<number>(() => ls(K.zoom, 100));

  // dayNotes are school-shared (backend, GET /calendar-notes)
  const [dayNotes, setDayNotes] = useState<Record<string, string>>({});
  const [cellColors, setCellColors] = useState<Record<string, string>>(() => ls(K.cellColors, {}));
  const [groupColors, setGroupColors] = useState<Record<string, string>>(() => ls(K.groupColors, {}));

  // sessionKey: `${blockId}_${dateISO}`
  const [weekSessions, setWeekSessions] = useState<Record<string, WeekSessionMeta>>({});
  // cancelledSessions: `${blockId}_${dateISO}` → true (server-side CANCELLED status)
  const [cancelledSessions, setCancelledSessions] = useState<Record<string, true>>({});
  // sessionStatuses: `${blockId}_${dateISO}` → lifecycle status string (isolated from weekSessions)
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, string>>({});

  // Week-truth overlay state (Owner/Admin backend-truth display) — populated by
  // loadWeekTruth() below; read here so getGroupsInCell can merge it in per-cell.
  const [weekTruthG, setWeekTruthG] = useState<GMap>({});
  const [weekTruthSC, setWeekTruthSC] = useState<SC>({});
  const [weekTruthKey, setWeekTruthKey] = useState<string | null>(null);

  // Load school-shared day notes from server once on mount. GET /calendar-notes is
  // OWNER/ADMIN-only server-side (see routes/calendarNotes.ts) — skip the call for
  // every other role instead of firing a request that always 403s.
  useEffect(() => {
    if (!isAdminRole) return;
    api.get('/calendar-notes')
      .then(res => {
        if (!res.data?.success) return;
        const map: Record<string, string> = {};
        for (const n of res.data.data as { date: string; content: string }[]) map[n.date] = n.content;
        setDayNotes(map);
      })
      .catch(() => { /* non-fatal: notes are auxiliary */ });
  }, [isAdminRole]);

  useEffect(() => {
    ss(K.zoom, zoom);
    ss(K.cellColors, cellColors); ss(K.groupColors, groupColors);
  }, [zoom, cellColors, groupColors]);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  // Per-data-generation caches, invalidated on the same deps that change
  // getGroupsInCell's identity. The grid memo pass calls getGroupsInCell for
  // every cell (slots × days); a (group, day) pair's candidates and a lesson
  // time's slot resolution are identical across all slot cells of that day —
  // recomputing them per cell made the pass O(cells × groups × slots).
  const cellCalc = useMemo(() => ({
    candidates: new Map<string, CellLessonCandidate[]>(),
    slotForTime: new Map<string, TimeSlot | null>(),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps mirror getGroupsInCell: they only reset the caches
  }), [SC, slots, weekSessions, cancelledSessions, structureTick]);

  const getGroupsInCell = useCallback(function getGroupsInCell(ci: number, sid: number, date?: Date): SchedGroup[] {
    const G = GRef.current;
    if (!date) return (SC[scKey(ci, sid)] ?? []).map(id => G[String(id)]).filter(Boolean);
    const dk = dateKey(date);

    const slotObj = slots.find(s => s.id === sid);
    if (!slotObj) return [];

    // Week-truth overlay: for the currently-loaded week only, union in groups the
    // ranged truth fetch returned but the global (no-range) fetch excluded — closed/
    // cancelled/completed blocks the Owner/Admin grid must still show as read-only.
    // G wins on id collision (already-live source, no reason to prefer the overlay copy).
    const weekTruthActive = weekTruthKey != null && weekKey(date) === weekTruthKey;
    const cellKeyStr = scKey(ci, sid);
    const G_ = weekTruthActive ? { ...weekTruthG, ...G } : G;
    const cellIds = weekTruthActive
      ? [...new Set([...(SC[cellKeyStr] ?? []), ...(weekTruthSC[cellKeyStr] ?? [])])]
      : (SC[cellKeyStr] ?? []);

    // Filter G dynamically applying single-session time overrides.
    // Single pass: candidates are computed once per group (this runs for every
    // grid cell × every group, so the doubled filter+map walk was a hot path).
    const effectiveGroups: Array<{ g: SchedGroup; candidates: CellLessonCandidate[] }> = [];
    for (const g of Object.values(G_)) {
      // Candidates depend only on structural group fields + weekSessions — both
      // invalidate cellCalc — so the cache is safe across per-student (ta/book) edits.
      const candKey = `${g.id}|${ci}|${dk}`;
      let candidates = cellCalc.candidates.get(candKey);
      if (!candidates) {
        candidates = lessonCandidatesForCell(g, ci, dk, weekSessions);
        cellCalc.candidates.set(candKey, candidates);
      }
      if (candidates.length === 0) continue;
      const inCell = candidates.some(candidate => slotMatchesLesson(slotObj, candidate.start, candidate.end, slots, cellCalc.slotForTime))
        || (candidates.some(candidate => !lessonMapsToAnySlot(candidate.start, candidate.end, slots, cellCalc.slotForTime)) && cellIds.includes(g.id));
      if (inCell) effectiveGroups.push({ g, candidates });
    }

    return effectiveGroups.map(({ g, candidates }) => {
      const matchedCandidate = candidates.find(candidate => slotMatchesLesson(slotObj, candidate.start, candidate.end, slots, cellCalc.slotForTime));
      const session = matchedCandidate?.session ?? null;

      const overrides: Partial<typeof g> = {};
      if (matchedCandidate?.kind === 'grammar') {
        const clubMatchesThisSlot = candidates.some(candidate =>
          candidate.kind === 'club' && slotMatchesLesson(slotObj, candidate.start, candidate.end, slots, cellCalc.slotForTime)
        );
        overrides.grammarDays = g.grammarDays.includes(ci) ? g.grammarDays : [...g.grammarDays, ci];
        if (g.clubDays.includes(ci) && !clubMatchesThisSlot) {
          overrides.clubDays = g.clubDays.filter(day => day !== ci);
        }
        overrides.grammarStartTime = matchedCandidate.start;
        overrides.grammarEndTime = matchedCandidate.end;
      } else if (matchedCandidate?.kind === 'club') {
        const grammarMatchesThisSlot = candidates.some(candidate =>
          candidate.kind === 'grammar' && slotMatchesLesson(slotObj, candidate.start, candidate.end, slots, cellCalc.slotForTime)
        );
        overrides.clubDays = g.clubDays.includes(ci) ? g.clubDays : [...g.clubDays, ci];
        if (g.grammarDays.includes(ci) && !grammarMatchesThisSlot) {
          overrides.grammarDays = g.grammarDays.filter(day => day !== ci);
        }
        overrides.clubStartTime = matchedCandidate.start;
        overrides.clubEndTime = matchedCandidate.end;
      }

      // Apply cabinet override if exists
      if (session?.cabinetIdSnap && session.cabinetIdSnap !== g.cabinetId) {
        overrides.n = session.cabinetNameSnap ?? `Кабинет ${session.cabinetIdSnap}`;
      }
      // For historical sessions (COMPLETED/LOCKED where block teacher changed in-place):
      // show the original teacher from teacherIdSnap, not the current block teacher
      if (session?.isHistoricalTeacher && session?.subTeacherName) {
        if (matchedCandidate?.kind === 'club') {
          overrides.tk = session.subTeacherName;
        } else {
          overrides.tg = session.subTeacherName;
        }
      }

      return Object.keys(overrides).length ? { ...g, ...overrides } : g;
    }).filter(g => {
      const blockId = lessonBlockIdForDay(g, ci);
      const hasSessionForDate = weekSessions[sessionKey(blockId, dk)] !== undefined;
      return shouldShowGroupForDate(g, dk, hasSessionForDate);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- G is read via GRef (see above); structureTick stands in for grid-visible G changes
  }, [SC, slots, weekSessions, structureTick, weekTruthG, weekTruthSC, weekTruthKey]);

  // ─── Student mutations ─────────────────────────────────────────────────────

  const updateStudent = useCallback((gid: number, stuId: number, patch: Partial<SchedStudent>) => {
    setG(prev => {
      const g = prev[String(gid)];
      if (!g) return prev;
      return {
        ...prev,
        [String(gid)]: {
          ...g,
          stu: g.stu.map(s => s.id === stuId ? { ...s, ...patch } : s),
        },
      };
    });
  }, []);

  const removeStudent = useCallback((gid: number, stuId: number) => {
    setG(prev => {
      const g = prev[String(gid)];
      if (!g) return prev;
      return { ...prev, [String(gid)]: { ...g, stu: g.stu.filter(s => s.id !== stuId) } };
    });
    setStructureTick(t => t + 1); // roster size is visible in grid chips
  }, []);

  // Group-level patch (e.g. chapter counter). Bumps structureTick — grid views may show it.
  const updateGroup = useCallback((gid: number, patch: Partial<SchedGroup>) => {
    setG(prev => {
      const g = prev[String(gid)];
      if (!g) return prev;
      return { ...prev, [String(gid)]: { ...g, ...patch } };
    });
    setStructureTick(t => t + 1);
  }, []);

  // Local roster patch after a successful add — mirrors removeStudent (no full reload),
  // so an in-progress draft attendance ta on other students in this group is never
  // touched. New student always starts unmarked (ta: null).
  const addStudent = useCallback((gid: number, student: SchedStudent) => {
    setG(prev => {
      const g = prev[String(gid)];
      if (!g || g.stu.some(s => s.id === student.id)) return prev;
      return { ...prev, [String(gid)]: { ...g, stu: [...g.stu, student] } };
    });
  }, []);

  const cycleAttendance = useCallback((gid: number, stuId: number) => {
    setG(prev => {
      const g = prev[String(gid)];
      if (!g) return prev;
      return {
        ...prev,
        [String(gid)]: {
          ...g,
          stu: g.stu.map(s => {
            if (s.id !== stuId) return s;
            const next = s.ta === null ? 'pr' : s.ta === 'pr' ? 'ab' : null;
            return { ...s, ta: next };
          }),
        },
      };
    });
  }, []);

  // Toggle: all present ↔ all unmarked. gta mirrors the bulk header button state.
  const markAllPresent = useCallback((gid: number) => {
    setG(prev => {
      const g = prev[String(gid)];
      if (!g) return prev;
      const alreadyAll = g.gta === 'pr';
      return { ...prev, [String(gid)]: { ...g, gta: alreadyAll ? null : 'pr', stu: g.stu.map(s => ({ ...s, ta: alreadyAll ? null : 'pr' })) } };
    });
  }, []);

  // ─── Notes ────────────────────────────────────────────────────────────────

  // School-shared day note: optimistic local update + persist to backend; resync from server on failure
  const setDayNote = useCallback((dk: string, text: string) => {
    const content = text.trim();
    setDayNotes(prev => {
      const n = { ...prev };
      if (content) n[dk] = content; else delete n[dk];
      return n;
    });
    api.put(`/calendar-notes/${dk}`, { content }).catch(() => {
      toast.error('Не удалось сохранить заметку');
      api.get('/calendar-notes')
        .then(res => {
          if (!res.data?.success) return;
          const map: Record<string, string> = {};
          for (const n of res.data.data as { date: string; content: string }[]) map[n.date] = n.content;
          setDayNotes(map);
        })
        .catch(() => {});
    });
  }, []);

  // ─── Cell colors ──────────────────────────────────────────────────────────

  const setCellColor = useCallback((ci: number, sid: number, color: string) => {
    const k = scKey(ci, sid);
    setCellColors(prev => color ? { ...prev, [k]: color } : (() => { const n = { ...prev }; delete n[k]; return n; })());
  }, []);

  const setGroupColor = useCallback((gid: number, color: string) => {
    setGroupColors(prev => color ? { ...prev, [String(gid)]: color } : (() => { const n = { ...prev }; delete n[String(gid)]; return n; })());
  }, []);

  // ─── Load from server (replaces local state with server data) ───────────────

  // dbSlots — слоты из БД (GET /api/settings/timeslots).
  // Если не переданы, используется DEFAULT_SLOTS как запасной вариант.
  // Block-merging/grouping is a pure computation — see scheduleBlockMerge.ts
  // (unit-tested there). This callback only wires the result into React state.
  const loadFromServer = useCallback((serverBlocks: ServerBlock[], dbSlots?: TimeSlot[], activeDays?: number[]) => {
    const { newG, newSC, baseSlots, legacyDaysArr, legacySlotIds } =
      buildScheduleStateFromBlocks(serverBlocks, dbSlots, activeDays, aDaysRef.current);

    blockDaysRef.current = serverBlocks.flatMap(b => b.days).filter(d => d >= 0 && d <= 6);

    // Snapshot the real DB slot IDs keyed by time so applySchedulePolicy can
    // always resolve a stable ID regardless of which week is currently viewed.
    dbSlotIdMapRef.current = new Map(baseSlots.map(sl => [`${sl.s}|${sl.e}`, sl.id]));
    setSlots(baseSlots);
    setG(prev => mergeAttendanceMarks(prev, newG));
    setSC(newSC);

    // Merge legacy days into aDays so legacy columns are visible in the grid
    const finalADays = [...new Set([
      ...(activeDays ?? aDaysRef.current).filter(d => d >= 0 && d <= 6),
      ...legacyDaysArr,
    ])].sort((a, b) => a - b);
    setADays(finalADays);
    setLegacyDays(legacyDaysArr);
    setLegacySlotIds(legacySlotIds);
  }, []);

  // ─── Apply CRM schedule settings (days + slot template) ──────────────────

  const applyActiveDays = useCallback((days: number[]) => {
    const filtered = days.filter(d => d >= 0 && d <= 6).sort();
    if (filtered.length > 0) setADays(filtered);
  }, []);

  // Apply a historical (or current) schedule policy fetched from GET /settings/timeslots?date=X.
  // Slot IDs are resolved from dbSlotIdMapRef (populated once by loadFromServer with real DB IDs).
  // This prevents "ID poisoning": previously the functional `prev` updater would carry stale IDs
  // from a historical-week visit into all subsequent navigations, producing sid <= 0 everywhere.
  // Fallback: s.id from the server response (real DB ID for current weeks, positive fake for
  // historical weeks where times no longer exist in the DB).
  //
  // policySlotTimes — the "startTime|endTime" keys that belong to the viewed-week policy
  // definition (generated by generatePolicySlotDefs on the server). Block/session occupied
  // times that are NOT in this set are classified as legacy. Provided by GET /settings/timeslots.
  // When absent (old server / no-date call) legacySlotIds is not overridden.
  const applySchedulePolicy = useCallback(({ activeDays: days, slots: serverSlots, policySlotTimes }: {
    activeDays: number[];
    slots: Array<{ id: number; startTime: string; endTime: string }>;
    policySlotTimes?: string[];
  }) => {
    const filtered = days.filter(d => d >= 0 && d <= 6).sort();
    if (filtered.length > 0) setADays(filtered);

    if (serverSlots.length > 0) {
      const resolvedSlots = serverSlots.map(s => {
        const resolvedId = dbSlotIdMapRef.current.get(`${s.startTime}|${s.endTime}`) ?? s.id;
        return { id: resolvedId, s: s.startTime, e: s.endTime };
      });
      setSlots(resolvedSlots);

      // Re-classify legacy slots using the viewed-week policy definition.
      // loadFromServer computed legacySlotIds from TODAY's policy — wrong when viewing
      // a future week under a different policy. policySlotTimes is the authoritative list
      // of slot times that belong to the viewed week's policy; anything else is legacy.
      if (policySlotTimes && policySlotTimes.length > 0) {
        const policyTimesSet = new Set(policySlotTimes);
        const newLegacySlotIds = resolvedSlots
          .filter(s => !policyTimesSet.has(`${s.s}|${s.e}`))
          .map(s => s.id);
        setLegacySlotIds(newLegacySlotIds);
      }
    }

    // Re-classify legacy days using the viewed-week activeDays.
    // blockDaysRef holds all raw days from the last loadFromServer call.
    if (filtered.length > 0 && blockDaysRef.current.length > 0) {
      const policyDaySet = new Set(filtered);
      const newLegacyDays = [...new Set(blockDaysRef.current)].filter(d => !policyDaySet.has(d));
      setLegacyDays(newLegacyDays);
    }
  }, []);

  // ─── Zoom ─────────────────────────────────────────────────────────────────

  const changeZoom = useCallback((delta: number) => {
    setZoom(prev => Math.max(50, Math.min(200, prev + delta)));
  }, []);

  const setZoomTo = useCallback((val: number) => {
    setZoom(Math.max(50, Math.min(200, val)));
  }, []);

  // ─── Session substitutes ──────────────────────────────────────────────────

  // AbortController ref — cancels in-flight request when week changes before response arrives
  const weekSessionsAbortRef = useRef<AbortController | null>(null);

  const loadWeekSessions = useCallback(async (wk: string) => {
    weekSessionsAbortRef.current?.abort();
    const ctrl = new AbortController();
    weekSessionsAbortRef.current = ctrl;

    try {
      const res = await api.get('/schedule/sessions/week', {
        params: { weekStart: wk },
        signal: ctrl.signal,
      });
      const sessions: RawWeekSession[] = res.data?.data ?? [];
      const { subMap, cancMap, statusMap } = buildWeekSessionMaps(sessions);
      // Keep state identity when the payload is unchanged. Realtime events re-fetch
      // the week on every attendance click anywhere in the school; fresh-but-equal
      // objects here would change getGroupsInCell's identity and defeat every grid
      // view's memo (WeekGrid/RoomsView/TeacherView/GroupView) for nothing.
      // ponytail: JSON compare (~100KB worst case, ~1ms) only runs per fetch, not per render.
      const keepIfEqual = <T,>(next: T) => (prev: T): T =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      setWeekSessions(keepIfEqual(subMap));
      setCancelledSessions(keepIfEqual(cancMap));
      setSessionStatuses(keepIfEqual(statusMap));
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED') return;
      /* silent for other errors */
    }
  }, []);

  // ─── Week truth overlay (Owner/Admin backend-truth display) ────────────────
  // A second, week-scoped GET /schedule?start&end call — reuses the endpoint's
  // existing ranged branch, which already returns any block whose lifecycle
  // (startDate/endDate) intersects the range, active or not. Only called from
  // the Owner/Admin Schedule page; TeacherSchedule.tsx never calls this, so
  // weekTruthG/SC stay empty there and getGroupsInCell's overlay is a no-op —
  // teacher mode stays byte-identical with zero conditionals in this hook.
  const weekTruthAbortRef = useRef<AbortController | null>(null);

  const loadWeekTruth = useCallback(async (wk: string) => {
    weekTruthAbortRef.current?.abort();
    const ctrl = new AbortController();
    weekTruthAbortRef.current = ctrl;

    const dates = weekDates(wk);
    const start = formatLocalIso(dates[0]);
    const end = formatLocalIso(dates[6]);

    try {
      const res = await api.get('/schedule', { params: { start, end }, signal: ctrl.signal });
      const blocks: ServerBlock[] = res.data?.data ?? [];
      const { newG, newSC } = buildScheduleStateFromBlocks(blocks, slots, aDaysRef.current, aDaysRef.current);
      setWeekTruthG(newG);
      setWeekTruthSC(newSC);
      setWeekTruthKey(wk);
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED') return;
      /* silent — truth overlay is a diagnostic supplement, not critical path */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slots read fresh each call via closure; re-created when slots identity changes is fine (no loop risk, not in a render-driving effect)
  }, [slots]);

  const getSessionSubstitute = useCallback((blockId: number, dateISO: string) => {
    return weekSessions[sessionKey(blockId, dateISO)] ?? null;
  }, [weekSessions]);

  const getWeekSession = useCallback((blockId: number, dateISO: string) => {
    return weekSessions[sessionKey(blockId, dateISO)] ?? null;
  }, [weekSessions]);

  const getSessionStatus = useCallback((blockId: number, dateISO: string): string => {
    return sessionStatuses[sessionKey(blockId, dateISO)] ?? 'UPCOMING';
  }, [sessionStatuses]);

  const updateSessionStatus = useCallback((blockId: number, dateISO: string, status: string) => {
    setSessionStatuses(prev => {
      const key = sessionKey(blockId, dateISO);
      if (prev[key] === status) return prev;
      return { ...prev, [key]: status };
    });
  }, []);

  const updateWeekSession = useCallback((blockId: number, dateISO: string, data: Partial<WeekSessionMeta>) => {
    setWeekSessions(prev => {
      const key = sessionKey(blockId, dateISO);
      const existing = prev[key] ?? { subTeacherId: 0, subTeacherName: '', startTimeSnap: null, endTimeSnap: null, cabinetIdSnap: null };
      return { ...prev, [key]: { ...existing, ...data } };
    });
  }, []);

  const markSessionCancelled = useCallback((blockId: number, dateISO: string, cancelled: boolean) => {
    setCancelledSessions(prev => {
      const key = sessionKey(blockId, dateISO);
      if (cancelled) return { ...prev, [key]: true };
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const isBlockCancelled = useCallback((blockId: number, dateISO: string) => {
    return Boolean(cancelledSessions[sessionKey(blockId, dateISO)]);
  }, [cancelledSessions]);


  return {
    // State
    G, SC, slots, aDays, legacyDays, legacySlotIds, zoom,
    dayNotes, cellColors, groupColors,
    // Derived
    getGroupsInCell,
    // Bumps only on grid-visible G changes (roster/chapter) — memo key for grid
    // views that read sched.G but never render per-student ta/book.
    structureTick,
    // Student
    updateStudent, removeStudent, updateGroup, addStudent,
    cycleAttendance, markAllPresent,
    // Notes
    setDayNote,
    // Colors
    setCellColor, setGroupColor,
    // Zoom
    changeZoom, setZoomTo,
    // Load from server
    loadFromServer,
    applyActiveDays,
    applySchedulePolicy,
    // Session substitutes + server-side cancellations
    loadWeekSessions, getSessionSubstitute, getWeekSession, weekSessions,
    updateWeekSession, markSessionCancelled,
    cancelledSessions, isBlockCancelled,
    // Week-truth overlay (Owner/Admin backend-truth display)
    loadWeekTruth,
    // Session lifecycle statuses
    sessionStatuses, getSessionStatus, updateSessionStatus,
    // Week helpers (re-exported)
    weekKey, weekDates, weekLabel, addWeeks, dateKey,
  };
}
export type UseSchedule = ReturnType<typeof useSchedule>;
