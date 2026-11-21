import { useState, useEffect, useRef } from 'react';
import { RefreshCw, X, Loader2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { paymentApi, refundApi, formatMoney, financeErrorMessage } from '../../lib/financeApi';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';
import type { Payment } from '../../types';

interface RefundModalProps {
  paymentId: number;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function RefundModal({ paymentId, isOpen, onClose, onSuccess }: RefundModalProps) {
  const [payment, setPayment]           = useState<Payment | null>(null);
  const [loading, setLoading]           = useState(false);
  const [fetchError, setFetchError]     = useState<string | null>(null);
  const [amounts, setAmounts]           = useState<Record<number, string>>({});
  const [reason, setReason]             = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [pendingRefundId, setPendingRefundId] = useState<number | null>(null);
  // One key per submission attempt: stable across retries of the same refund
  // (server replays instead of double-refunding), fresh when the inputs change.
  const refundKeyRef = useRef<string>(crypto.randomUUID());
  useEffect(() => { refundKeyRef.current = crypto.randomUUID(); }, [amounts, reason]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setFetchError(null);
    setPendingRefundId(null);
    paymentApi.get(paymentId)
      .then(p => {
        setPayment(p);
        const init: Record<number, string> = {};
        (p.allocations ?? []).forEach(a => { init[a.id] = String(parseFloat(a.amount)); });
        setAmounts(init);
      })
      .catch(() => setFetchError('Не удалось загрузить данные платежа'))
      .finally(() => setLoading(false));
  }, [isOpen, paymentId]);

  const handleClose = () => {
    setPayment(null);
    setReason('');
    setAmounts({});
    setFetchError(null);
    setPendingRefundId(null);
    onClose();
  };

  const handleConfirmOnly = async () => {
    if (!pendingRefundId) return;
    setSubmitting(true);
    try {
      await refundApi.confirm(pendingRefundId);
      toast.success(`Возврат #${pendingRefundId} подтверждён`);
      setPendingRefundId(null);
      onSuccess();
      handleClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!payment) return;
    if (!reason.trim()) { toast.error('Укажите причину возврата'); return; }

    const allocationInputs = (payment.allocations ?? [])
      .map(a => ({ paymentAllocationId: a.id, amount: parseFloat(amounts[a.id] ?? '0') }))
      .filter(a => a.amount > 0);

    if (allocationInputs.length === 0) {
      toast.error('Укажите сумму возврата хотя бы по одному инвойсу');
      return;
    }

    setSubmitting(true);
    try {
      const refund = await refundApi.create(payment.id, { reason: reason.trim(), allocations: allocationInputs }, refundKeyRef.current);
      try {
        await refundApi.confirm(refund.id);
        toast.success(`Возврат #${refund.id} подтверждён`);
        onSuccess();
        handleClose();
      } catch (confirmErr: unknown) {
        // Refund created but confirm failed — show retry UI with refund ID
        setPendingRefundId(refund.id);
        const msg = (confirmErr as { response?: { data?: { error?: string } } })?.response?.data?.error;
        toast.error(`Возврат #${refund.id} создан, подтверждение не прошло: ${financeErrorMessage(msg)}`);
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(financeErrorMessage(msg));
    } finally {
      setSubmitting(false);
    }
  };

  useBodyScrollLock(isOpen);
  useBackButtonClose(isOpen, onClose);

  if (!isOpen) return null;

  const allocations = payment?.allocations ?? [];
  const totalRefund = Object.values(amounts).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-surfaceLowest w-full max-w-lg rounded-2xl shadow-2xl overflow-x-hidden max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-600">
              <RefreshCw className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-textPrimary">
                Возврат по платежу #{String(paymentId).padStart(4, '0')}
              </h3>
              <p className="text-xs text-textSecondary">Возврат будет применён к выбранным инвойсам</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-surfaceLow rounded-lg transition-colors text-textSecondary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">

          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-textSecondary text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Загрузка данных платежа...
            </div>
          )}

          {fetchError && (
            <div className="flex items-center gap-2 px-4 py-3 bg-danger/5 border border-danger/20 rounded-xl text-danger text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {fetchError}
            </div>
          )}

          {/* Pending confirm retry panel */}
          {pendingRefundId && (
            <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl">
              <p className="font-bold text-amber-700 text-sm mb-1">
                Возврат #{pendingRefundId} создан, но не подтверждён
              </p>
              <p className="text-xs text-textSecondary mb-3">
                Нажмите «Подтвердить» чтобы завершить возврат. Если проблема повторяется — обратитесь к администратору.
              </p>
              <button
                onClick={handleConfirmOnly}
                disabled={submitting}
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-lg text-xs font-bold hover:bg-amber-600 transition-colors disabled:opacity-50"
              >
                {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
                Подтвердить #{pendingRefundId}
              </button>
            </div>
          )}

          {payment && !loading && !pendingRefundId && (
            <>
              {allocations.length === 0 ? (
                <div className="py-6 text-center">
                  <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-amber-500" />
                  <p className="text-sm text-textSecondary">
                    Этот платёж не привязан ни к одному инвойсу. Возврат недоступен.
                  </p>
                </div>
              ) : (
                <>
                  {/* Allocations list */}
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase text-textSecondary">
                      Инвойсы в этом платеже
                    </p>
                    {allocations.map(a => (
                      <div key={a.id} className="flex items-center gap-3 bg-surfaceLow rounded-xl px-4 py-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-textPrimary">
                            Инвойс #{String(a.invoiceId).padStart(4, '0')}
                          </p>
                          <p className="text-xs text-textSecondary">
                            Оплачено: {formatMoney(a.amount)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            max={parseFloat(a.amount)}
                            value={amounts[a.id] ?? ''}
                            onChange={e => setAmounts(prev => ({ ...prev, [a.id]: e.target.value }))}
                            placeholder="0"
                            className="w-28 bg-surfaceLowest rounded-lg px-3 py-2 text-sm font-semibold text-right outline-none focus:ring-2 focus:ring-primary/20"
                          />
                          <span className="text-xs text-textSecondary">KGS</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Total */}
                  <div className="flex items-center justify-between px-4 py-2.5 bg-amber-500/5 border border-amber-500/10 rounded-xl">
                    <span className="text-xs font-bold text-textSecondary uppercase tracking-wider">
                      Итого к возврату
                    </span>
                    <span className="font-bold text-amber-700">
                      {formatMoney(totalRefund.toFixed(2))}
                    </span>
                  </div>

                  {/* Reason */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-textSecondary block">
                      Причина возврата *
                    </label>
                    <input
                      type="text"
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      placeholder="Например: отказ от обучения"
                      className="w-full bg-surfaceLow rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {payment && !loading && allocations.length > 0 && !pendingRefundId && (
          <div className="flex gap-3 px-6 pb-6">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 bg-surfaceLow text-textPrimary font-bold py-3 rounded-xl hover:bg-border/20 transition-colors"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !reason.trim() || totalRefund <= 0}
              className="flex-1 bg-amber-500 text-white font-bold py-3 rounded-xl hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting ? 'Обработка...' : 'Оформить возврат'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
