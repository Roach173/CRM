import { ArrowRight, Users, BookOpen, CheckCircle } from 'lucide-react';
import { Modal, ModalContent, ModalHeader, ModalTitle, ModalBody, ModalFooter } from './Modal';
import { Button } from './Button';

export interface PromoteResult {
  sourceGroup: { id: number; level: string; chapter: number; status: string };
  newGroup:    { id: number; level: string; chapter: number };
  progression: { id: number; fromGroupId: number; toGroupId: number };
  copiedStudentsCount: number;
  copiedBlocksCount: number;
  completedSourceGroup: boolean;
}

interface Props {
  result: PromoteResult;
  onNavigate: () => void;
  onClose: () => void;
}

export default function PromoteResultModal({ result, onNavigate, onClose }: Props) {
  return (
    <Modal open onOpenChange={(v) => { if (!v) onClose(); }}>
      <ModalContent showClose={false} className="max-w-sm">
        <ModalHeader>
          <ModalTitle>Группа переведена ✓</ModalTitle>
        </ModalHeader>

        <ModalBody className="space-y-3">
          {/* Level arrow */}
          <div className="flex items-center justify-center gap-3 py-1">
            <span className="text-sm font-bold text-textSecondary">{result.sourceGroup.level}</span>
            <ArrowRight className="w-4 h-4 text-primary" />
            <span className="text-sm font-bold text-primary">{result.newGroup.level}</span>
          </div>

          {/* New group card */}
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-primary">Новая группа</p>
            <p className="text-sm font-semibold text-textPrimary">{result.newGroup.level} · Глава {result.newGroup.chapter}</p>
            <div className="flex gap-4 text-xs text-textSecondary">
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" />
                {result.copiedStudentsCount} студ.
              </span>
              <span className="flex items-center gap-1">
                <BookOpen className="w-3 h-3" />
                {result.copiedBlocksCount} блок(а)
              </span>
            </div>
          </div>

          {result.completedSourceGroup && (
            <p className="text-xs text-textSecondary flex items-start gap-1.5">
              <CheckCircle className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
              Старая группа завершена — будущие уроки аннулированы, история сохранена
            </p>
          )}
        </ModalBody>

        <ModalFooter className="flex-col gap-2">
          <Button variant="primary" className="w-full" onClick={onNavigate}>
            Перейти к новой группе
          </Button>
          <Button variant="outline" className="w-full" onClick={onClose}>
            Остаться здесь
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
