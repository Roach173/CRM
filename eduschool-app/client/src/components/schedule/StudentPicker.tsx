import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import api from '../../lib/api';
import { useDebounce } from '../../hooks/useDebounce';

// Server-side page size for the picker's dropdown. Kept well under the school's
// full roster (up to 3 000 students) so opening the picker never table-scans the
// whole school — see students.ts GET / (limit clamped 1..3000, default 50).
// The `total` from the response's meta tells us when more exist so the UI can
// say so instead of silently hiding students outside this page (the original bug).
const SEARCH_LIMIT = 30;

// Convention used elsewhere in the codebase for server-side search (see
// Students.tsx, CLAUDE.md "Server-side pagination ... Debounced search 350ms").
const SEARCH_DEBOUNCE_MS = 350;

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg: '#FFFFFF',
  bgOff: '#FAFAF8',
  bgLight: '#F3F2EE',
  border: '#E5E4DC',
  borderSoft: '#EDECE5',
  text: '#1A1A18',
  mid: '#6B6B62',
  light: '#9B9B90',
  primary: '#2D6A4F',
  primaryLight: '#E8F5E9',
  blue: '#1565C0',
  blueLight: '#E3F2FD',
  red: '#C62828',
  redLight: '#FFEBEE',
  orange: '#E65100',
  orangeLight: '#FFF3E0',
  green: '#1B5E20',
  greenLight: '#E8F5E9',
};

type ApiStudentGroup = {
  id: number;
  level: string;
};

export type ApiStudent = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  studentProfile: {
    id: number;
    enrolledGroups?: ApiStudentGroup[];
  } | null;
};


export default function StudentPicker({
  selectedIds, excludeIds = new Set(), onAdd, onRemove, showChips = false,
}: {
  selectedIds: Set<number>;
  excludeIds?: Set<number>;
  onAdd: (s: ApiStudent) => void;
  onRemove: (profileId: number) => void;
  showChips?: boolean;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [open, setOpen] = useState(false);

  // Current server page, plus enough bookkeeping to render loading/empty/error
  // states and to warn the user when more students exist than fit on the page.
  const [results, setResults] = useState<ApiStudent[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  // Every student ever returned by any search this picker has done, keyed by
  // studentProfile.id. Selected-student chips are resolved from here rather than
  // from `results` because the page that contained a since-selected student may
  // have long since scrolled out as the user kept typing.
  const [knownById, setKnownById] = useState<Map<number, ApiStudent>>(new Map());

  const abortRef = useRef<AbortController | null>(null);

  // Query the server (debounced) instead of filtering a one-time client snapshot.
  // The old implementation fetched page 1 (50 rows, alphabetical) exactly once and
  // filtered it in memory — a freshly created student outside that window was
  // unreachable no matter what was typed. Re-fetches on every open too, so a
  // student created seconds ago is visible immediately without a stale cache.
  useEffect(() => {
    if (!open) return;

    // Cancel any still-in-flight request before starting a new one so a slow
    // response for an earlier keystroke (e.g. "П") can never land after, and
    // overwrite, the newer results for "Попов".
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setErrored(false);

    api.get('/students', {
      params: { search: debouncedSearch.trim() || undefined, limit: SEARCH_LIMIT },
      signal: controller.signal,
    })
      .then(res => {
        const data: ApiStudent[] = res.data?.data ?? [];
        setResults(data);
        setTotal(typeof res.data?.meta?.total === 'number' ? res.data.meta.total : data.length);
        setKnownById(prev => {
          const next = new Map(prev);
          data.forEach(s => { if (s.studentProfile) next.set(s.studentProfile.id, s); });
          return next;
        });
      })
      .catch(err => {
        if (axios.isCancel(err)) return; // superseded by a newer keystroke — not a real failure
        setResults([]);
        setErrored(true);
      })
      .finally(() => {
        // Guard against an aborted/superseded request's `finally` clearing the
        // spinner for the request that replaced it.
        if (abortRef.current === controller) setLoading(false);
      });

    return () => controller.abort();
  }, [open, debouncedSearch]);

  const filtered = results.filter(s =>
    s.studentProfile &&
    !selectedIds.has(s.studentProfile.id) &&
    !excludeIds.has(s.studentProfile.id)
  );

  const selectedStudents = useMemo(
    () => Array.from(knownById.values()).filter(s => s.studentProfile && selectedIds.has(s.studentProfile.id)),
    [knownById, selectedIds]
  );

  // True when the server has more matches than fit on this page — tells the user
  // more students exist rather than letting them conclude the student is missing.
  const truncated = total !== null && total > results.length;

  const inp: React.CSSProperties = {
    width: '100%', fontSize: 12, padding: '5px 10px',
    border: `1px solid ${C.border}`, borderRadius: 7,
    background: C.bg, color: C.text, outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div>
      {showChips && selectedStudents.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {selectedStudents.map(s => (
            <span key={s.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 11, padding: '2px 8px', borderRadius: 20,
              background: C.primaryLight, color: C.primary, fontWeight: 600,
            }}>
              {s.firstName} {s.lastName}
              <button type="button" onClick={() => onRemove(s.studentProfile!.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.primary, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
            </span>
          ))}
        </div>
      )}

      <input
        style={inp}
        placeholder="Поиск по имени или email..."
        value={search}
        onFocus={() => setOpen(true)}
        onChange={e => { setSearch(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />

      {open && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, marginTop: 4, maxHeight: 200, overflowY: 'auto', background: C.bg, position: 'relative', zIndex: 10 }}>
          {loading ? (
            <div style={{ padding: '8px 10px', fontSize: 12, color: C.mid }}>Поиск...</div>
          ) : errored ? (
            <div style={{ padding: '8px 10px', fontSize: 12, color: C.red }}>
              Не удалось загрузить студентов. Попробуйте ещё раз.
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '8px 10px', fontSize: 12, color: C.light }}>
              {search ? 'Студент не найден' : 'Все студенты уже добавлены'}
            </div>
          ) : (
            <>
              {filtered.map(s => {
                const groups = s.studentProfile?.enrolledGroups ?? [];
                return (
                  <div key={s.id}
                    onMouseDown={() => { onAdd(s); setSearch(''); setOpen(false); }}
                    style={{ padding: '7px 10px', cursor: 'pointer', fontSize: 12, color: C.text, borderBottom: `1px solid ${C.borderSoft}` }}
                    onMouseEnter={e => (e.currentTarget.style.background = C.bgLight)}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <strong>{s.firstName} {s.lastName}</strong>
                      <span style={{ color: C.mid }}>{s.email}</span>
                      {groups.length > 0 && (
                        <span style={{
                          fontSize: 10, padding: '1px 6px', borderRadius: 10,
                          background: C.orangeLight, color: C.orange, fontWeight: 600,
                        }}>
                          В группе: {groups.map(g => g.level).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {truncated && (
                <div style={{ padding: '6px 10px', fontSize: 11, color: C.light, fontStyle: 'italic', borderTop: `1px solid ${C.borderSoft}` }}>
                  Показаны первые {results.length} из {total}. Уточните поиск, чтобы найти нужного студента.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
