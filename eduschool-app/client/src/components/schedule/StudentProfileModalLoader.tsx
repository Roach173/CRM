import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { StudentProfileModal } from '../../pages/dashboard/admin/Students';
import type { Student } from '../../pages/dashboard/admin/Students';
import { Spinner } from '../ui/Spinner';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';

interface Props {
  profileId: number | null;
  onClose: () => void;
  onNotesSaved?: (notes: string) => void;
  onFinancialsChanged?: (fields: { credits: number; paidUntil: string | null }) => void;
  onPausedChanged?: (paused: boolean) => void;
}

export default function StudentProfileModalLoader({ profileId, onClose, onNotesSaved, onFinancialsChanged, onPausedChanged }: Props) {
  const [student, setStudent] = useState<Student | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useBodyScrollLock(!!profileId);
  useBackButtonClose(!!profileId, onClose);

  useEffect(() => {
    if (!profileId) {
      setStudent(null);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    api.get(`/students/by-profile/${profileId}`)
      .then(res => {
        const d = res.data.data;
        const firstBlock = d.studentProfile?.enrolledGroups?.[0]?.blocks?.[0];
        setStudent({
          id: d.id,
          studentProfileId: d.studentProfile?.id ?? null,
          name: `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim(),
          phone: d.phone ?? '',
          email: d.email ?? '',
          level: d.studentProfile?.level ?? d.studentProfile?.enrolledGroups?.[0]?.level ?? '',
          cabinet: firstBlock?.cabinet?.name ?? '',
          time: firstBlock ? `${firstBlock.startTime ?? ''}–${firstBlock.endTime ?? ''}` : '',
          credits: d.studentProfile?.credits ?? 0,
          paidUntil: d.studentProfile?.paidUntil
            ? new Date(d.studentProfile.paidUntil).toISOString().slice(0, 10)
            : null,
          paused: d.studentProfile?.isFrozen ?? false,
          comment: d.studentProfile?.notes ?? '',
          lessonType: 'all',
          archivedAt: d.archivedAt ?? null,
          deletedAt: d.deletedAt ?? null,
        });
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [profileId]);

  if (!profileId) return null;

  if (loading) {
    return (
      <div
        className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40"
        onClick={onClose}
      >
        <Spinner />
      </div>
    );
  }

  if (error) return null;

  return (
    <StudentProfileModal
      student={student}
      isOpen={!!student}
      onClose={onClose}
      onUpdate={setStudent}
      onNotesSaved={onNotesSaved}
      onFinancialsChanged={onFinancialsChanged}
      onPausedChanged={onPausedChanged}
      // The modal owns the archive PATCH + toast and calls onClose() itself on
      // success (onClose is passed straight through above). This callback's
      // only job is clearing this loader's own cached profile so a re-open
      // before unmount can't flash stale (now-archived) data.
      onArchived={() => setStudent(null)}
    />
  );
}
