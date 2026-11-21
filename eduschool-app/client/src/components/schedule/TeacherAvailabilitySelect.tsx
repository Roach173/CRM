import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import type { SchedGroup } from './scheduleTypes';
import { findTeacherConflicts, getConflictSeverity } from '../../utils/scheduleConflicts';
import * as S from './teacherAvailabilityStyles';

type Teacher = { id: number; firstName: string; lastName: string };
type AvailStatus = 'free' | 'busy-elsewhere' | 'conflict';

interface Props {
  value: string;
  onChange: (v: string) => void;
  teachers: Teacher[];
  days: number[];
  startTime: string;
  endTime: string;
  schedGroups: Record<string, SchedGroup>;
  excludeBlockIds?: number[];
  targetDate?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  style?: React.CSSProperties;
}

const STATUS_COLOR: Record<AvailStatus, string> = {
  free: '#2D6A4F',
  'busy-elsewhere': '#E65100',
  conflict: '#C62828',
};

const STATUS_LABEL: Record<AvailStatus, string | null> = {
  free: null,
  'busy-elsewhere': 'занят в другое время',
  conflict: 'конфликт — занят',
};

const STATUS_ORDER: Record<AvailStatus, number> = { free: 0, 'busy-elsewhere': 1, conflict: 2 };

function StatusDot({ status }: { status: AvailStatus }) {
  return <span style={S.statusDot(STATUS_COLOR[status])} />;
}

export function TeacherAvailabilitySelect({
  value, onChange, teachers, days, startTime, endTime,
  schedGroups, excludeBlockIds = [], placeholder = '— Выберите учителя —',
  targetDate, allowEmpty = false, style,
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

  const statusMap = useMemo(() => {
    const map = new Map<number, { status: AvailStatus; tooltip: string }>();
    const conflictOptions = targetDate ? { targetStartDate: targetDate } : undefined;
    for (const t of teachers) {
      const conflicts = findTeacherConflicts(t.id, days, startTime, endTime, schedGroups, excludeBlockIds, conflictOptions);
      const severity = getConflictSeverity(conflicts);
      const status: AvailStatus = severity === 'critical' ? 'conflict'
        : severity === 'warning' ? 'busy-elsewhere'
        : 'free';
      const tooltip = conflicts.length > 0 ? conflicts.map(c => c.message).join('\n') : '';
      map.set(t.id, { status, tooltip });
    }
    return map;
  }, [teachers, days, startTime, endTime, schedGroups, excludeBlockIds, targetDate]);

  const sorted = useMemo(() => (
    [...teachers].sort((a, b) => {
      const sa = statusMap.get(a.id)?.status ?? 'free';
      const sb = statusMap.get(b.id)?.status ?? 'free';
      return STATUS_ORDER[sa] - STATUS_ORDER[sb];
    })
  ), [teachers, statusMap]);

  // Unified flat option list for keyboard navigation
  type OptionItem = { id: string; disabled: boolean };
  const options = useMemo<OptionItem[]>(() => {
    const result: OptionItem[] = [];
    if (allowEmpty) result.push({ id: '', disabled: false });
    for (const t of sorted) {
      const { status } = statusMap.get(t.id) ?? { status: 'free' as AvailStatus };
      result.push({ id: String(t.id), disabled: status === 'conflict' });
    }
    return result;
  }, [allowEmpty, sorted, statusMap]);

  const selectByIndex = useCallback((idx: number) => {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.id);
    setOpen(false);
    setFocusedIndex(-1);
  }, [options, onChange]);

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

  const selectedTeacher = teachers.find(t => String(t.id) === value);
  const selectedEntry = selectedTeacher
    ? (statusMap.get(selectedTeacher.id) ?? { status: 'free' as AvailStatus, tooltip: '' })
    : { status: 'free' as AvailStatus, tooltip: '' };

  // Teacher option index (offset by 1 if allowEmpty)
  const teacherOptionIndex = (sortedIdx: number) => (allowEmpty ? 1 : 0) + sortedIdx;

  return (
    <div ref={containerRef} style={S.container}>
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          setFocusedIndex(next ? 0 : -1);
        }}
        onKeyDown={handleKeyDown}
        className="sch-field"
        style={S.triggerStyle(!!selectedTeacher, style)}
        title={selectedEntry.tooltip || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedTeacher ? (
          <>
            <StatusDot status={selectedEntry.status} />
            <span style={S.flex1}>{selectedTeacher.firstName} {selectedTeacher.lastName}</span>
          </>
        ) : (
          <span style={S.flex1}>{placeholder}</span>
        )}
        <span style={S.chevron}>▾</span>
      </button>

      {open && (
        <div style={S.dropdown} role="listbox" onKeyDown={handleKeyDown}>
          {allowEmpty && (
            <div
              role="option"
              aria-selected={value === ''}
              onClick={() => { onChange(''); setOpen(false); setFocusedIndex(-1); }}
              onMouseEnter={() => setFocusedIndex(0)}
              style={S.option(focusedIndex === 0, false, value === '')}
            >
              <span style={S.dotSpacer} />
              <span style={S.emptyLabel}>— Без учителя —</span>
            </div>
          )}
          {sorted.map((t, sortedIdx) => {
            const entry = statusMap.get(t.id) ?? { status: 'free' as AvailStatus, tooltip: '' };
            const { status, tooltip } = entry;
            const isDisabled = status === 'conflict';
            const label = STATUS_LABEL[status];
            const optIdx = teacherOptionIndex(sortedIdx);
            return (
              <div
                key={t.id}
                role="option"
                aria-selected={value === String(t.id)}
                aria-disabled={isDisabled}
                title={tooltip || undefined}
                onClick={isDisabled ? undefined : () => { onChange(String(t.id)); setOpen(false); setFocusedIndex(-1); }}
                onMouseEnter={() => { if (!isDisabled) setFocusedIndex(optIdx); }}
                style={S.option(focusedIndex === optIdx, isDisabled, value === String(t.id))}
              >
                <StatusDot status={status} />
                <span style={S.flex1}>{t.firstName} {t.lastName}</span>
                {label && (
                  <span style={{ fontSize: 10, color: STATUS_COLOR[status], flexShrink: 0 }}>
                    {label}
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
