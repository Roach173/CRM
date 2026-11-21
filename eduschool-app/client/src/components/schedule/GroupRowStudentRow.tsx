import React, { useState } from 'react';
import toast from 'react-hot-toast';
import type { UseSchedule } from '../../hooks/useSchedule';
import type { SchedStudent } from './scheduleTypes';
import api from '../../lib/api';
import { C } from './scheduleTheme';
import * as GRS from './groupRowStyles';
import { attLabel, attBtnStyle, bookBtnStyle, parsePd } from './GroupRowBadges';
import { Spinner } from '../ui/Spinner';
import ConfirmModal from '../ui/ConfirmModal';

// ponytail: 36px on mobile, not the 44px ideal — 44 would push the chapter cell to
// 120px and force the control row to wrap on a 360px screen. With the 8px sibling
// gap the effective target lands ~44 and it clears WCAG 2.5.8 (24px) comfortably.
export function chapterBtn(isMobile = false): React.CSSProperties {
  const size = isMobile ? 36 : 18;
  return {
    width: size, height: size, borderRadius: '50%', border: `1px solid ${C.border}`,
    background: C.bg, color: C.text, fontSize: isMobile ? 18 : 12, lineHeight: 1, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0,
  };
}
// Fixed-width chapter cell so the header and row controls form one aligned column
export function chapterCtl(isMobile = false): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 3, flexShrink: 0,
    width: isMobile ? 104 : 66, justifyContent: 'center',
  };
}
export function chapterNum(isMobile = false): React.CSSProperties {
  return { fontSize: isMobile ? 14 : 12, fontWeight: 700, color: C.text, minWidth: 22, textAlign: 'center' };
}

interface StudentRowProps {
  stu: SchedStudent; gid: number; sched: UseSchedule;
  onSelect: () => void; selected: boolean;
  onOpenProfile: () => void;
  onToggleBook?: () => void;
  onChapterDelta?: (delta: number) => void;
  attendanceEditable: boolean;
  // Drives the «на паузе» badge. True while the student is currently paused (freeze state),
  // independent of how this lesson is marked — only unpausing clears it. The caller
  // (GroupRow) computes this; see showPaused there.
  paused: boolean;
  // Hides the «⋮ Удалить из группы» menu — DELETE /groups/:id/students/:id requires
  // schedule:write, which TEACHER doesn't have (matches onToggleBook/onChapterDelta
  // above, already gated the same way via canBook/canChapter in GroupRow).
  isTeacher?: boolean;
  // True while this row's group is fetching /session/for-date (fires once per expand,
  // see useGroupRowActions). Shows a spinner instead of the attendance pill so the
  // "Не отмечен" default doesn't flash before the real mark arrives.
  attLoading?: boolean;
  // Passed down from SlotPanel rather than each row calling useIsMobile() — a group
  // can hold 100+ rows and that would be 100+ resize listeners.
  isMobile?: boolean;
}

export function StudentRow({ stu, gid, sched, onSelect, selected, onOpenProfile, onToggleBook, onChapterDelta, attendanceEditable, paused, isTeacher = false, attLoading = false, isMobile = false }: StudentRowProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const overdue = stu.st === 'ov';
  // «на паузе» = student is currently paused (paused prop). Shows regardless of the
  // attendance mark; a paused student can still be marked present/absent (the credit is
  // skipped separately via the FREEZE_SKIP ledger, not by hiding the mark).
  const onHold = paused;
  const paidInfo = parsePd(stu.pd);
  const idx = stu.id % 6;
  const initials = stu.n.trim().split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const sideColor = overdue ? '#E24B4A' : onHold ? '#1565C0' : 'transparent';

  const AVATAR_BG = ['#E6F1FB', '#E8F5E9', '#FFF3E0', '#F3E5F5', '#FCE4EC', '#E0F2F1'];
  const AVATAR_FG = ['#0C447C', '#1B5E20', '#E65100', '#4A148C', '#880E4F', '#00695C'];

  const handleRemove = async () => {
    try {
      const g = sched.G[String(gid)];
      if (g.studentGroupId) {
        await api.delete(`/groups/${g.studentGroupId}/students/${stu.id}`);
      } else {
        toast.error('Удаление студента недоступно: группа без cohort-привязки. Обратитесь к администратору.');
        return;
      }
      sched.removeStudent(gid, stu.id);
      setShowMenu(false);
    } catch (err) {
      console.error(err);
      toast.error('Ошибка при удалении студента');
    }
  };

  // Attendance is always edited as a LOCAL draft — a click cycles the mark in place and
  // nothing is written until the group's «Сдать/Сохранить» button. This holds whether the
  // lesson was never submitted or was already finalized (that button reopens+re-submits).
  const attClickable = attendanceEditable;
  const handleAttClick = () => {
    if (!attClickable) return;
    sched.cycleAttendance(gid, stu.id);
  };

  return (
    <div style={GRS.studentRowBorder(sideColor, isMobile)}>
      <div onClick={() => { onSelect(); onOpenProfile(); }} style={GRS.studentRowArea(selected, isMobile)}>
        <div style={GRS.studentAvatar(AVATAR_BG[idx], AVATAR_FG[idx])}>
          {initials || '?'}
        </div>
        <div style={GRS.studentInfo}>
          <div style={GRS.studentInfoRow}>
            <span style={{ fontSize: isMobile ? 15 : 13, fontWeight: 600, color: C.text }}>{stu.n}</span>
            {stu.st === 'ok' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#639922' }} />}
            {onHold && <span style={{ fontSize: isMobile ? 12 : 10, background: '#E3F2FD', color: '#1565C0', borderRadius: 4, padding: '1px 5px', fontWeight: 500 }}>на паузе</span>}
            {stu.cr != null && (
              <span
                title="Уроков на балансе (кредит)"
                style={{ fontSize: isMobile ? 12 : 10, background: stu.cr > 0 ? '#E8F5E9' : '#FDECEA', color: stu.cr > 0 ? '#1B5E20' : '#C62828', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}
              >{stu.cr} ур.</span>
            )}
            {paidInfo
              ? <span style={{ fontSize: isMobile ? 12 : 11, color: paidInfo.color, fontWeight: 600 }}>· оплачено до {paidInfo.text}</span>
              : <span style={{ fontSize: isMobile ? 12 : 11, color: C.light, fontWeight: 600 }}>· оплачено до —</span>}
          </div>
          {stu.cm && <div style={GRS.studentNote(isMobile)} title={stu.cm}>📝 {stu.cm}</div>}
        </div>
        <div style={GRS.studentActions(isMobile)} onClick={isMobile ? e => e.stopPropagation() : undefined}>
          {onChapterDelta && (
            <div style={chapterCtl(isMobile)} title="Глава студента" onClick={e => e.stopPropagation()}>
              <button onClick={() => onChapterDelta(-1)} style={chapterBtn(isMobile)}>−</button>
              <span style={chapterNum(isMobile)}>{stu.ch || 1}</span>
              <button onClick={() => onChapterDelta(1)} style={chapterBtn(isMobile)}>+</button>
            </div>
          )}
          {onToggleBook && (
            <button
              onClick={e => { e.stopPropagation(); onToggleBook(); }}
              title={stu.book ? 'Книга выдана' : 'Книга не выдана'}
              style={bookBtnStyle(stu.book, isMobile)}
            >Книга</button>
          )}
          {/* Single pill style for a given status — draft edits look identical to a saved mark */}
          {attLoading ? (
            <div style={{ ...attBtnStyle(stu.ta, isMobile), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spinner size="sm" className="h-3.5 w-3.5 border-current border-t-transparent" />
            </div>
          ) : (
            <button
              onClick={e => { e.stopPropagation(); handleAttClick(); }}
              disabled={!attClickable}
              title={attClickable ? `${attLabel(stu.ta)} — нажмите, чтобы изменить` : attLabel(stu.ta)}
              style={{
                ...attBtnStyle(stu.ta, isMobile),
                opacity: attClickable ? 1 : 0.5,
                cursor: attClickable ? 'pointer' : 'not-allowed',
              }}
            >
              {attLabel(stu.ta)}
            </button>
          )}
          {!isTeacher && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={e => { e.stopPropagation(); setShowMenu(!showMenu); }}
                aria-label="Действия со студентом"
                style={GRS.menuButtonStu}
              >⋮</button>
              {showMenu && (
                <>
                  <div style={GRS.menuBackdrop(isMobile)} onClick={e => { e.stopPropagation(); setShowMenu(false); }} />
                  {/* Mobile: bottom sheet, not a dropdown. `absolute; top: 100%` put the
                      menu off the bottom edge of the panel for the last rows in a group. */}
                  <div style={GRS.menuDropdown(isMobile)} onClick={e => e.stopPropagation()}>
                    <button onClick={() => { setShowMenu(false); setConfirmRemove(true); }} style={GRS.menuItemRemove(isMobile)}>
                      ✕ Удалить из группы
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <ConfirmModal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => { void handleRemove(); }}
        title="Удалить студента из группы?"
        message={`${stu.n} будет исключён из группы. История посещаемости и кредиты сохраняются.`}
      />
    </div>
  );
}
