import { AlertTriangle } from 'lucide-react';
import {
  AlertModal, AlertModalContent, AlertModalHeader, AlertModalFooter,
  AlertModalTitle, AlertModalDescription, AlertModalAction, AlertModalCancel,
} from './Modal';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
}

export default function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Удалить',
  cancelText = 'Отмена',
  isDanger = true,
}: ConfirmModalProps) {
  return (
    <AlertModal open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertModalContent
          onEscapeKeyDown={() => onClose()}
        >
        <AlertModalHeader>
          <div className="flex justify-between items-start mb-4">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isDanger ? 'bg-danger/10 text-danger' : 'bg-primary/10 text-primary'}`}>
              <AlertTriangle className="w-6 h-6" />
            </div>
          </div>
          <AlertModalTitle className="text-2xl font-serif text-textPrimary leading-tight">
            {title}
          </AlertModalTitle>
          <AlertModalDescription className="text-textSecondary text-sm leading-relaxed font-medium mt-2">
            {message}
          </AlertModalDescription>
        </AlertModalHeader>

        <AlertModalFooter>
          <AlertModalCancel
            onClick={onClose}
            className="flex-1 px-6 py-3.5 rounded-2xl text-xs font-black uppercase tracking-widest text-textSecondary hover:bg-surfaceLow transition"
          >
            {cancelText}
          </AlertModalCancel>
          <AlertModalAction
            onClick={() => { onConfirm(); onClose(); }}
            className={`flex-1 px-6 py-3.5 rounded-2xl text-xs font-black uppercase tracking-widest text-white shadow-xl transition active:scale-95 ${isDanger ? 'bg-danger shadow-danger/20 hover:brightness-110' : 'bg-primary shadow-primary/20 hover:brightness-110'}`}
          >
            {confirmText}
          </AlertModalAction>
        </AlertModalFooter>
      </AlertModalContent>
    </AlertModal>
  );
}
