import { useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalTitle, ModalBody, ModalFooter } from './Modal';

type GroupStatus = 'ACTIVE' | 'COMPLETED' | 'PAUSED';

interface Props {
  open: boolean;
  groupName: string;
  groupStatus: GroupStatus;
  canArchiveGroup?: boolean;
  onComplete?: () => Promise<void>;
  onPause?: () => Promise<void>;
  onResume?: () => Promise<void>;
  onArchive?: () => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

export default function GroupActionModal({
  open, groupName, groupStatus,
  canArchiveGroup = false,
  onComplete, onPause, onResume, onArchive, onDelete,
  onClose,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleClose() {
    setConfirmDelete(false);
    onClose();
  }

  async function run(action: (() => Promise<void>) | undefined) {
    if (!action) return;
    setLoading(true);
    try {
      await action();
      setConfirmDelete(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <ModalContent showClose={false} className="max-w-xs">
        <ModalHeader>
          <ModalTitle>
            {confirmDelete ? 'Удалить группу?' : 'Действия с группой'}
          </ModalTitle>
        </ModalHeader>

        <ModalBody className="space-y-2">
          {!confirmDelete ? (
            <>
              <p className="text-xs text-textSecondary mb-3 truncate">«{groupName}»</p>

              {/* ACTIVE: complete (owner) + pause (admin+owner) */}
              {groupStatus === 'ACTIVE' && (
                <>
                  {canArchiveGroup && (
                    <button
                      onClick={() => run(onComplete)}
                      disabled={loading}
                      className="w-full py-2.5 bg-green-50 text-green-900 border border-green-400 rounded-lg text-sm font-bold hover:bg-green-100 transition-colors disabled:opacity-50"
                    >
                      Завершить курс
                    </button>
                  )}
                  <button
                    onClick={() => run(onPause)}
                    disabled={loading}
                    className="w-full py-2.5 bg-yellow-50 text-yellow-900 border border-yellow-400 rounded-lg text-sm font-bold hover:bg-yellow-100 transition-colors disabled:opacity-50"
                  >
                    Приостановить
                  </button>
                </>
              )}

              {/* PAUSED: resume only */}
              {groupStatus === 'PAUSED' && (
                <button
                  onClick={() => run(onResume)}
                  disabled={loading}
                  className="w-full py-2.5 bg-green-50 text-green-900 border border-green-400 rounded-lg text-sm font-bold hover:bg-green-100 transition-colors disabled:opacity-50"
                >
                  Возобновить группу
                </button>
              )}

              {/* COMPLETED: archive (owner only) */}
              {groupStatus === 'COMPLETED' && canArchiveGroup && (
                <button
                  onClick={() => run(onArchive)}
                  disabled={loading}
                  className="w-full py-2.5 bg-surfaceLow text-textSecondary border border-border rounded-lg text-sm font-bold hover:bg-surfaceLowest transition-colors disabled:opacity-50"
                >
                  Архивировать
                </button>
              )}

              {/* Delete forever — owner only */}
              {canArchiveGroup && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={loading}
                  className="w-full py-2.5 bg-red-50 text-red-900 border border-red-300 rounded-lg text-sm font-bold hover:bg-red-100 transition-colors disabled:opacity-50"
                >
                  Удалить навсегда
                </button>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-textSecondary mb-3 leading-relaxed">
                Группа «{groupName}» будет удалена безвозвратно вместе со всеми данными. Это действие нельзя отменить.
              </p>
              <button
                onClick={() => run(onDelete)}
                disabled={loading}
                className="w-full py-2.5 bg-danger text-white rounded-lg text-sm font-bold hover:brightness-110 transition disabled:opacity-50"
              >
                {loading ? 'Удаление...' : 'Да, удалить'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={loading}
                className="w-full py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surfaceLow transition-colors"
              >
                Назад
              </button>
            </>
          )}
        </ModalBody>

        {!confirmDelete && (
          <ModalFooter>
            <button
              onClick={handleClose}
              disabled={loading}
              className="w-full py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surfaceLow transition-colors"
            >
              Отмена
            </button>
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
  );
}
