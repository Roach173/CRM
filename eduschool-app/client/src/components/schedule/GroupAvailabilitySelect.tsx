import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import type { SchedGroup } from './scheduleTypes';
import type { StudentGroup } from '../../types';
import { findStudentGroupConflicts } from '../../utils/scheduleConflicts';
import type { ConflictOptions } from '../../utils/scheduleConflicts';
import * as S from './teacherAvailabilityStyles';

type AvailStatus = 'free' | 'busy';

const STATUS_COLOR: Record<AvailStatus, string> = {
  free: '#2D6A4F',
  busy: '#C62828',
};

function StatusDot({ status }: { status: AvailStatus }) {
  return <span style={S.statusDot(STATUS_COLOR[status])} />;
}

interface Props {
  value: string;
  onChange: (id: string, group: StudentGroup | undefined) => void;
  groups: StudentGroup[];
  days: number[];
  startTime: string;
  endTime: string;
  schedGroups: Record<string, SchedGroup>;
  conflictOptions?: ConflictOptions;
  placeholder?: string;
  style?: React.CSSProperties;
}

export function GroupAvailabilitySelect({
  value, onChange, groups, days, startTime, endTime,
  schedGroups, conflictOptions, placeholder = '— Выберите группу —', style,
}: Props) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFocusedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const canCheck = !!(startTime && endTime && days.length > 0);

  const statusMap = useMemo(() => {
    const map = new Map<number, AvailStatus>();
    for (const g of groups) {
      if (!canCheck) {
        map.set(g.id, 'free');
        continue;
      }
      const conflicts = findStudentGroupConflicts(g.id, days, startTime, endTime, schedGroups, [], conflictOptions);
      map.set(g.id, conflicts.length > 0 ? 'busy' : 'free');
    }
    return map;
  }, [groups, days, startTime, endTime, schedGroups, conflictOptions, canCheck]);

  const sorted = useMemo(() => (
    [...groups].sort((a, b) => {
      const sa = statusMap.get(a.id) ?? 'free';
      const sb = statusMap.get(b.id) ?? 'free';
      if (sa === sb) return 0;
      return sa === 'free' ? -1 : 1;
    })
  ), [groups, statusMap]);

  const options = useMemo(() => sorted.map(g => ({
    id: String(g.id),
    disabled: false,
  })), [sorted]);

  const selectByIndex = useCallback((idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    const grp = groups.find(g => String(g.id) === opt.id);
    onChange(opt.id, grp);
    setOpen(false);
    setFocusedIndex(-1);
  }, [options, groups, onChange]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
        setFocusedIndex(0);
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        setFocusedIndex(-1);
        break;
      case 'Tab':
        setOpen(false);
        setFocusedIndex(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex(i => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        selectByIndex(focusedIndex);
        break;
    }
  }, [open, options.length, focusedIndex, selectByIndex]);

  const selectedGroup = groups.find(g => String(g.id) === value);
  const selectedStatus: AvailStatus = selectedGroup
    ? (statusMap.get(selectedGroup.id) ?? 'free')
    : 'free';

  return (
    <div ref={containerRef} style={S.container}>
      <button
        type="button"
        onClick={() => { const next = !open; setOpen(next); setFocusedIndex(next ? 0 : -1); }}
        onKeyDown={handleKeyDown}
        style={S.triggerStyle(!!selectedGroup, style)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedGroup ? (
          <>
            {canCheck && <StatusDot status={selectedStatus} />}
            <span style={S.flex1}>
              {selectedGroup.level} ({selectedGroup._count?.students ?? 0} студ.)
            </span>
          </>
        ) : (
          <span style={S.flex1}>{placeholder}</span>
        )}
        <span style={S.chevron}>▾</span>
      </button>

      {open && (
        <div style={S.dropdown} role="listbox" onKeyDown={handleKeyDown}>
          {sorted.map((g, idx) => {
            const status = statusMap.get(g.id) ?? 'free';
            return (
              <div
                key={g.id}
                role="option"
                aria-selected={value === String(g.id)}
                onClick={() => { const grp = groups.find(gr => gr.id === g.id); onChange(String(g.id), grp); setOpen(false); setFocusedIndex(-1); }}
                onMouseEnter={() => setFocusedIndex(idx)}
                style={S.option(focusedIndex === idx, false, value === String(g.id))}
              >
                {canCheck && <StatusDot status={status} />}
                <span style={S.flex1}>
                  {g.level} ({g._count?.students ?? 0} студ.)
                </span>
                {status === 'busy' && (
                  <span style={{ fontSize: 10, color: STATUS_COLOR.busy, flexShrink: 0 }}>
                    конфликт
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
