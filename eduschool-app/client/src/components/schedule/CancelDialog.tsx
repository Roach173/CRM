import { useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '../ui/Modal';

interface Props {
  open: boolean;
  onOneTime: (reason: string) => void;
  onRestore: () => void;
  isCancelled: boolean;
  onClose: () => void;
}

export default function CancelDialog({ open, onOneTime, onRestore, isCancelled, onClose }: Props) {
  const [step, setStep] = useState<'choose' | 'reason'>('choose');
  const [reason, setReason] = useState('');

  function handleClose() {
    setStep('choose');
    setReason('');
    onClose();
  }

  function handleConfirm() {
    onOneTime(reason.trim());
    setStep('choose');
    setReason('');
  }

  // Reason is optional; if provided, keep the 5-char minimum for a meaningful note.
  const reasonValid = reason.trim().length === 0 || reason.trim().length >= 5;

  return (
    <Modal open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <ModalContent showClose={false} className="max-w-xs">
        <ModalHeader>
          <ModalTitle>
            {isCancelled ? 'Восстановить занятие?' : step === 'reason' ? 'Причина отмены' : 'Отменить занятие?'}
          </ModalTitle>
        </ModalHeader>

        <ModalBody className="space-y-2">
          {isCancelled ? (
            <>
              <p className="text-xs text-textSecondary mb-2">
                Занятие отменено. Восстановление доступно, если по нему ещё нет финансовых операций.
              </p>
              <button
                onClick={onRestore}
                className="w-full py-2.5 bg-green-50 text-green-900 border border-green-300 rounded-lg text-sm font-bold hover:bg-green-100 transition-colors"
              >
                Восстановить занятие
              </button>
            </>
          ) : step === 'choose' ? (
            <>
              <p className="text-xs text-textSecondary mb-2">
                Будет отменён только <strong>этот</strong> урок. Будущие занятия группы продолжатся по расписанию.
              </p>
              <button
                onClick={() => setStep('reason')}
                className="w-full py-2.5 bg-yellow-50 text-yellow-900 border border-yellow-400 rounded-lg text-sm font-bold hover:bg-yellow-100 transition-colors"
              >
                Отменить этот урок
              </button>
              <p className="text-xs text-textSecondary">
                Чтобы завершить всю группу — используйте пункт «Завершить группу» в меню группы.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-textSecondary mb-1">Причина отмены (необязательно, если указываете — минимум 5 символов):</p>
              <textarea
                autoFocus
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Например: праздничный день, болезнь учителя..."
                className="w-full border border-border rounded-lg p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
              />
              {reason.trim().length > 0 && !reasonValid && (
                <p className="text-xs text-red-500">Минимум 5 символов</p>
              )}
              <button
                onClick={handleConfirm}
                disabled={!reasonValid}
                className="w-full py-2.5 bg-yellow-50 text-yellow-900 border border-yellow-400 rounded-lg text-sm font-bold hover:bg-yellow-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Отменить занятие
              </button>
              <button
                onClick={() => { setStep('choose'); setReason(''); }}
                className="w-full py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surfaceLow transition-colors"
              >
                ← Назад
              </button>
            </>
          )}
        </ModalBody>

        {(isCancelled || step === 'choose') && (
          <ModalFooter>
            <button
              onClick={handleClose}
              className="w-full py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surfaceLow transition-colors"
            >
              Закрыть
            </button>
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
  );
}
