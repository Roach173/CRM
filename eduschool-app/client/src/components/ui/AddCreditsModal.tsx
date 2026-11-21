import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, ModalTitle, ModalDescription } from './Modal';

interface AddCreditsModalProps {
  isOpen: boolean;
  onClose: () => void;
  student: {
    id: number;
    firstName: string;
    lastName: string;
    studentProfile: { id: number } | null;
  } | null;
  onSuccess: (amount: number) => void;
}

export function AddCreditsModal({ isOpen, onClose, student, onSuccess }: AddCreditsModalProps) {
  const [amount, setAmount] = useState<number | ''>('');
  const [reason, setReason] = useState('Оплата за обучение');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reset = () => { setAmount(''); setReason('Оплата за обучение'); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!student?.studentProfile || amount === '') return;

    setIsSubmitting(true);
    try {
      const res = await api.post('/credits/add', {
        studentProfileId: student.studentProfile.id,
        amount: Number(amount),
        reason,
      });
      if (res.data?.success || res.data) {
        onSuccess(Number(amount));
        reset();
        onClose();
      } else {
        toast.error(res.data?.error || 'Ошибка при начислении кредитов');
      }
    } catch {
      toast.error('Сетевая ошибка при начислении кредитов');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal open={isOpen && !!student} onOpenChange={(open) => { if (!open) { reset(); onClose(); } }}>
      <ModalContent>
        <ModalHeader>
          <div className="flex items-center gap-3 pr-8">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
              <CreditCard className="w-5 h-5" />
            </div>
            <div>
              <ModalTitle>Пополнение баланса</ModalTitle>
              <ModalDescription className="mt-0.5">
                {student?.firstName} {student?.lastName}
              </ModalDescription>
            </div>
          </div>
        </ModalHeader>

        <form onSubmit={handleSubmit}>
          <ModalBody className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-textSecondary block">
                Количество кредитов
              </label>
              <input
                type="number"
                required
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                placeholder="Например: 10"
                className="w-full bg-surfaceLow border-none rounded-xl text-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-textSecondary block">
                Причина пополнения / списания
              </label>
              <input
                type="text"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Оплата за обучение..."
                className="w-full bg-surfaceLow border-none rounded-xl text-sm px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </ModalBody>

          <ModalFooter>
            <button
              type="button"
              onClick={() => { reset(); onClose(); }}
              className="flex-1 bg-surfaceLow text-textPrimary font-bold py-3 rounded-2xl hover:bg-border/20 transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 bg-primary text-white font-bold py-3 rounded-2xl hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isSubmitting ? 'Сохранение...' : 'Сохранить'}
            </button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
