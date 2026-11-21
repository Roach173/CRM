import { useState, useCallback } from 'react';
import ConfirmModal from '../components/ui/ConfirmModal';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
}

type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void };

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const handleConfirm = () => {
    pending?.resolve(true);
    setPending(null);
  };

  const handleClose = () => {
    pending?.resolve(false);
    setPending(null);
  };

  const ConfirmDialog = pending ? (
    <ConfirmModal
      isOpen
      onClose={handleClose}
      onConfirm={handleConfirm}
      title={pending.title}
      message={pending.message}
      confirmText={pending.confirmText}
      cancelText={pending.cancelText}
      isDanger={pending.isDanger}
    />
  ) : null;

  return { confirm, ConfirmDialog };
}
