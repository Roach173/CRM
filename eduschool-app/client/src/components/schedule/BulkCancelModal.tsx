import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import { weekKey } from '../../hooks/useSchedule';
import { Modal, ModalContent, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '../ui/Modal';
import { C } from './scheduleTheme';
import { DAYS_SHORT as DAY_LABELS } from './scheduleTypes';
const MONTH_LABELS = [
  'января','февраля','марта','апреля','мая','июня',
  'июля','августа','сентября','октября','ноября','декабря',
];

interface BulkCancelResult {
  cancelled: number;
  errors: { sessionId: number; error: string }[];
}

interface Props {
  open: boolean;
  viewWk: string;        // "2026-05-25" — Monday of viewed week
  activeDays: number[];  // working day indices: 0=Пн..6=Вс
  timezone: string;
  initialDate?: string;  // pre-selected date — skips 'day' step
  initialLabel?: string; // human label for the pre-selected date
  onSuccess: () => void; // call when cancelled > 0 → triggers loadWeekSessions()
  onClose: () => void;
}

function getDayISO(weekStart: string, dayIndex: number): string {
  const d = new Date(weekStart + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dayIndex);
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(iso: string, dayIndex: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  return `${DAY_LABELS[dayIndex]} ${d.getUTCDate()} ${MONTH_LABELS[d.getUTCMonth()]}`;
}

export default function BulkCancelModal({ open, viewWk, activeDays, timezone, initialDate, initialLabel, onSuccess, onClose }: Props) {
  const [step, setStep] = useState<'day' | 'reason' | 'result'>('day');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BulkCancelResult | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (open) {
      if (initialDate) {
        setStep('reason');
        setSelectedDate(initialDate);
        setSelectedLabel(initialLabel ?? initialDate);
      } else {
        setStep('day');
        setSelectedDate(null);
        setSelectedLabel('');
      }
      setReason('');
      setSaving(false);
      setError('');
      setResult(null);
    }
  }, [open, initialDate, initialLabel]);

  const todayISO = new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
  const isCurrentWk = viewWk === weekKey(new Date(), timezone);
  const reasonValid = reason.trim().length >= 5;

  async function handleConfirm() {
    if (!selectedDate || !reasonValid || saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post('/schedule/sessions/bulk-cancel', {
        date: selectedDate,
        reason: reason.trim(),
      });
      if (!mountedRef.current) return;
      const data: BulkCancelResult = {
        cancelled: res.data.data.cancelled ?? 0,
        errors: res.data.data.errors ?? [],
      };
      if (data.cancelled === 0 && data.errors.length === 0) {
        toast('Нет предстоящих занятий на выбранный день');
        onClose();
        return;
      }
      setResult(data);
      setStep('result');
      if (data.cancelled > 0) onSuccess();
    } catch (err: any) {
      if (!mountedRef.current) return;
      setError(err.response?.data?.error ?? 'Ошибка запроса');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  function handleClose() {
    if (saving) return;
    onClose();
  }

  const inp: React.CSSProperties = {
    width: '100%', fontSize: 12, padding: '6px 8px',
    border: `1px solid ${C.border}`, borderRadius: 6,
    background: C.bg, color: C.text, boxSizing: 'border-box',
    outline: 'none', fontFamily: 'inherit', resize: 'none',
  };

  const lbl: React.CSSProperties = {
    fontSize: 11, color: C.mid, display: 'block', marginBottom: 3, fontWeight: 500,
  };

  const titleMap = { day: 'Отменить день', reason: 'Причина отмены', result: 'Результат' };

  return (
    <Modal open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <ModalContent showClose={false} className="max-w-sm">
        <ModalHeader>
          <ModalTitle>{titleMap[step]}</ModalTitle>
        </ModalHeader>

        <ModalBody className="space-y-4">

          {/* ── Step: day ──────────────────────────────────────────────────── */}
          {step === 'day' && (
            <>
              <div style={{
                background: C.orangeLight, border: `1px solid ${C.orange}`,
                borderRadius: 8, padding: '8px 12px',
                fontSize: 12, color: C.orange, lineHeight: 1.6,
              }}>
                ⚠ Будут отменены все предстоящие занятия выбранного дня.<br />
                Операцию нельзя отменить автоматически.
              </div>

              <div>
                <p style={{ ...lbl, marginBottom: 8 }}>Выберите день:</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[...activeDays].sort((a, b) => a - b).map((dayIdx) => {
                    const dayISO = getDayISO(viewWk, dayIdx);
                    const isPast = isCurrentWk && dayISO < todayISO;
                    const isSelected = selectedDate === dayISO;
                    const label = formatDayLabel(dayISO, dayIdx);

                    return (
                      <button
                        key={dayIdx}
                        disabled={isPast}
                        onClick={() => { setSelectedDate(dayISO); setSelectedLabel(label); }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '9px 12px', borderRadius: 8, fontSize: 13,
                          fontWeight: isSelected ? 700 : 500,
                          border: `1px solid ${isSelected ? C.primary : C.border}`,
                          background: isSelected ? C.primaryLight : isPast ? C.bgLight : C.bg,
                          color: isPast ? C.light : isSelected ? C.primary : C.text,
                          cursor: isPast ? 'not-allowed' : 'pointer',
                          transition: 'all 0.12s',
                          textAlign: 'left',
                        }}
                      >
                        <span>{label}</span>
                        {isPast && <span style={{ fontSize: 11 }}>🔒</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* ── Step: reason ───────────────────────────────────────────────── */}
          {step === 'reason' && (
            <>
              <p style={{ fontSize: 12, color: C.mid }}>📅 {selectedLabel}</p>

              <div style={{
                background: '#FFF8E1', border: '1px solid #FFD54F',
                borderRadius: 8, padding: '8px 12px',
                fontSize: 12, color: '#5D4037', lineHeight: 1.6,
              }}>
                Будут отменены все предстоящие занятия выбранного дня.<br />
                Точное количество будет определено сервером.
              </div>

              <div>
                <label style={lbl}>Причина отмены *</label>
                <textarea
                  autoFocus
                  rows={3}
                  value={reason}
                  onChange={e => { setReason(e.target.value); setError(''); }}
                  placeholder="Например: праздничный день, форс-мажор..."
                  style={inp}
                />
                {reason.trim().length > 0 && !reasonValid && (
                  <p style={{ fontSize: 11, color: C.red, marginTop: 2 }}>Минимум 5 символов</p>
                )}
              </div>

              {error && (
                <div style={{
                  fontSize: 12, color: C.red, background: C.redLight,
                  borderRadius: 6, padding: '6px 10px',
                }}>
                  {error}
                </div>
              )}
            </>
          )}

          {/* ── Step: result ───────────────────────────────────────────────── */}
          {step === 'result' && result && (
            <>
              {result.cancelled > 0 && (
                <div style={{
                  background: C.greenLight, border: `1px solid ${C.green}`,
                  borderRadius: 8, padding: '10px 12px',
                  fontSize: 13, color: C.green, fontWeight: 600,
                }}>
                  ✅ Отменено занятий: {result.cancelled}
                </div>
              )}

              {result.errors.length > 0 && result.cancelled > 0 && (
                <div style={{
                  background: C.orangeLight, border: `1px solid ${C.orange}`,
                  borderRadius: 8, padding: '10px 12px',
                  fontSize: 12, color: C.orange, lineHeight: 1.6,
                }}>
                  ⚠ Заблокировано: {result.errors.length}<br />
                  У этих занятий уже были списаны кредиты. Требуется корректировка вручную.
                </div>
              )}

              {result.errors.length > 0 && result.cancelled === 0 && (
                <div style={{
                  background: C.redLight, border: `1px solid ${C.red}`,
                  borderRadius: 8, padding: '10px 12px',
                  fontSize: 12, color: C.red, lineHeight: 1.6,
                }}>
                  ⛔ Отменить не удалось.<br />
                  У всех занятий уже были списаны кредиты. Требуется корректировка вручную.
                </div>
              )}
            </>
          )}

        </ModalBody>

        <ModalFooter>
          {step === 'day' && (
            <>
              <button
                onClick={() => { if (selectedDate) setStep('reason'); }}
                disabled={!selectedDate}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 7, border: 'none',
                  background: selectedDate ? C.primary : C.bgLight,
                  color: selectedDate ? '#fff' : C.light,
                  fontSize: 13, fontWeight: 700,
                  cursor: selectedDate ? 'pointer' : 'not-allowed',
                }}
              >
                Далее
              </button>
              <button
                onClick={handleClose}
                style={{
                  padding: '8px 16px', background: 'none',
                  border: `1px solid ${C.border}`, borderRadius: 7,
                  fontSize: 12, cursor: 'pointer', color: C.mid,
                }}
              >
                Отмена
              </button>
            </>
          )}

          {step === 'reason' && (
            <>
              <button
                onClick={handleConfirm}
                disabled={!reasonValid || saving}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 7, border: 'none',
                  background: reasonValid && !saving ? C.red : C.bgLight,
                  color: reasonValid && !saving ? '#fff' : C.light,
                  fontSize: 13, fontWeight: 700,
                  cursor: reasonValid && !saving ? 'pointer' : 'not-allowed',
                }}
              >
                {saving ? 'Отмена занятий...' : `Отменить — ${selectedLabel}`}
              </button>
              <button
                onClick={() => { setStep('day'); setError(''); }}
                disabled={saving}
                style={{
                  padding: '8px 16px', background: 'none',
                  border: `1px solid ${C.border}`, borderRadius: 7,
                  fontSize: 12, color: C.mid,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                ← Назад
              </button>
            </>
          )}

          {step === 'result' && (
            <button
              onClick={handleClose}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 7, border: 'none',
                background: C.primary, color: '#fff',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Закрыть
            </button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
