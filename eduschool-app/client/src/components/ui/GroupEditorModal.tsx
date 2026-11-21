import React, { useState, useMemo } from 'react';
import { Users, BookOpen } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import { Button } from './Button';
import { Input } from './Input';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, ModalTitle } from './Modal';
import { StudentGroup } from '../../types';
import StudentPicker, { ApiStudent } from '../schedule/StudentPicker';

const LEVELS = [
  'Beginner', 'Elementary', 'Pre-Intermediate',
  'Intermediate', 'Upper-Intermediate', 'Advanced',
];

interface GroupEditorModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (group: StudentGroup) => void;
  defaultLevel?: string;
}

export function GroupEditorModal({ open, onClose, onSuccess, defaultLevel }: GroupEditorModalProps) {
  const [tab, setTab] = useState<'info' | 'students'>('info');
  const [level, setLevel] = useState(defaultLevel || LEVELS[0]);
  const [chapter, setChapter] = useState('1');
  const [maxStudents, setMaxStudents] = useState('15');
  const [loading, setLoading] = useState(false);
  const [selectedStudents, setSelectedStudents] = useState<ApiStudent[]>([]);

  React.useEffect(() => {
    if (open) {
      setTab('info');
      setLevel(defaultLevel || LEVELS[0]);
      setChapter('1');
      setMaxStudents('15');
      setSelectedStudents([]);
    }
  }, [open, defaultLevel]);

  const selectedIds = useMemo(() => new Set(selectedStudents.map(s => s.studentProfile!.id)), [selectedStudents]);

  async function submit() {
    setLoading(true);
    try {
      const res = await api.post('/groups', {
        level,
        chapter: parseInt(chapter) || 1,
        maxStudents: parseInt(maxStudents) || 15,
        studentIds: Array.from(selectedIds),
      });
      toast.success('Группа создана');
      onSuccess(res.data.data);
      onClose();
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Ошибка');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <ModalContent showClose={false} className="flex flex-col max-h-[90vh] overflow-hidden">
        <ModalHeader className="shrink-0 pb-0">
          <ModalTitle className="pr-8">Создание группы</ModalTitle>
        </ModalHeader>

        {/* Tabs */}
        <div className="flex px-8 border-b border-border/40 shrink-0 mt-4">
          <button onClick={() => setTab('info')} className={`flex items-center gap-2 py-3 px-1 mr-6 text-sm font-semibold border-b-2 -mb-px transition-colors ${tab === 'info' ? 'border-primary text-primary' : 'border-transparent text-textSecondary hover:text-textPrimary'}`}>
            <BookOpen className="w-4 h-4" /> Основная инфо
          </button>
          <button onClick={() => setTab('students')} className={`flex items-center gap-2 py-3 px-1 text-sm font-semibold border-b-2 -mb-px transition-colors ${tab === 'students' ? 'border-primary text-primary' : 'border-transparent text-textSecondary hover:text-textPrimary'}`}>
            <Users className="w-4 h-4" /> Студенты ({selectedStudents.length})
          </button>
        </div>

        <ModalBody className="overflow-y-auto flex-1">
          {tab === 'info' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-textSecondary mb-1 block uppercase tracking-wider">Уровень <span className="text-danger">*</span></label>
                  <select value={level} onChange={e => setLevel(e.target.value)} className="w-full px-3 py-2 text-sm border border-border rounded-xl bg-background text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary/30 h-[42px]">
                    {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-textSecondary mb-1 block uppercase tracking-wider">Глава (Юнит)</label>
                  <Input type="number" value={chapter} onChange={e => setChapter(e.target.value)} placeholder="1" />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-textSecondary mb-1 block uppercase tracking-wider">Макс. студентов</label>
                <Input type="number" value={maxStudents} onChange={e => setMaxStudents(e.target.value)} placeholder="15" />
              </div>
            </div>
          )}
          {tab === 'students' && (
            <div className="space-y-4 min-h-[250px]">
              <label className="text-xs font-semibold text-textSecondary block uppercase tracking-wider">Выберите студентов</label>
              <StudentPicker
                selectedIds={selectedIds}
                showChips
                onAdd={(student) => { if (student.studentProfile) setSelectedStudents(prev => [...prev, student]); }}
                onRemove={(profileId) => setSelectedStudents(prev => prev.filter(s => s.studentProfile?.id !== profileId))}
              />
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          <Button variant="outline" className="flex-1" onClick={onClose}>Отмена</Button>
          <Button variant="primary" className="flex-1" onClick={submit} disabled={loading}>
            {loading ? 'Создание...' : 'Создать группу'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
