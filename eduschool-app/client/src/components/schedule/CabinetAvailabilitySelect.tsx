import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import type { SchedGroup } from './scheduleTypes';
import { findCabinetConflicts } from '../../utils/scheduleConflicts';
import type { ConflictOptions } from '../../utils/scheduleConflicts';
import * as S from './teacherAvailabilityStyles';

type Cabinet = { id: number; name: string; capacity: number };
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
  onChange: (v: string) => void;
  cabinets: Cabinet[];
  days: number[];
  startTime: string;
  endTime: string;
  schedGroups: Record<string, SchedGroup>;
  conflictOptions?: ConflictOptions;
  placeholder?: string;
  style?: React.CSSProperties;
}

export function CabinetAvailabilitySelect({
  value, onChange, cabinets, days, startTime, endTime,
  schedGroups, conflictOptions, placeholder = '— Выберите кабинет —', style,
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
    for (const cab of cabinets) {
      if (!canCheck) {
        map.set(cab.id, 'free');
        continue;
      }
      const conflicts = findCabinetConflicts(cab.id, days, startTime, endTime, schedGroups, [], conflictOptions);
      map.set(cab.id, conflicts.length > 0 ? 'busy' : 'free');
    }
    return map;
  }, [cabinets, days, startTime, endTime, schedGroups, conflictOptions, canCheck]);

  const sorted = useMemo(() => (
    [...cabinets].sort((a, b) => {
      const sa = statusMap.get(a.id) ?? 'free';
      const sb = statusMap.get(b.id) ?? 'free';
      if (sa === sb) return 0;
      return sa === 'free' ? -1 : 1;
    })
  ), [cabinets, statusMap]);

  const options = useMemo(() => sorted.map(c => ({
    id: String(c.id),
    disabled: statusMap.get(c.id) === 'busy',
  })), [sorted, statusMap]);

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

  const selectedCabinet = cabinets.find(c => String(c.id) === value);
  const selectedStatus: AvailStatus = selectedCabinet
    ? (statusMap.get(selectedCabinet.id) ?? 'free')
    : 'free';

  return (
    <div ref={containerRef} style={S.container}>
      <button
        type="button"
        onClick={() => { const next = !open; setOpen(next); setFocusedIndex(next ? 0 : -1); }}
        onKeyDown={handleKeyDown}
        style={S.triggerStyle(!!selectedCabinet, style)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedCabinet ? (
          <>
            {canCheck && <StatusDot status={selectedStatus} />}
            <span style={S.flex1}>{selectedCabinet.name} (мест: {selectedCabinet.capacity})</span>
          </>
        ) : (
          <span style={S.flex1}>{placeholder}</span>
        )}
        <span style={S.chevron}>▾</span>
      </button>

      {open && (
        <div style={S.dropdown} role="listbox" onKeyDown={handleKeyDown}>
          {sorted.map((cab, idx) => {
            const status = statusMap.get(cab.id) ?? 'free';
            const isDisabled = status === 'busy';
            return (
              <div
                key={cab.id}
                role="option"
                aria-selected={value === String(cab.id)}
                aria-disabled={isDisabled}
                onClick={isDisabled ? undefined : () => { onChange(String(cab.id)); setOpen(false); setFocusedIndex(-1); }}
                onMouseEnter={() => { if (!isDisabled) setFocusedIndex(idx); }}
                style={S.option(focusedIndex === idx, isDisabled, value === String(cab.id))}
              >
                {canCheck && <StatusDot status={status} />}
                <span style={S.flex1}>{cab.name} (мест: {cab.capacity})</span>
                {isDisabled && (
                  <span style={{ fontSize: 10, color: STATUS_COLOR.busy, flexShrink: 0 }}>
                    занят
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
