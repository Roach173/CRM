import React, { useState } from 'react';
import { CheckCircle, Phone } from 'lucide-react';
import api from '../../lib/api';
import { Spinner } from './Spinner';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, ModalTitle } from './Modal';
import { MIN_PASSWORD_LENGTH, passwordMinLengthHint } from '../../lib/passwordPolicy';

interface AddUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  role: 'STUDENT' | 'TEACHER' | 'ADMIN';
  onSuccess?: () => void;
}

const roleLabels = {
  STUDENT: 'Новый студент',
  TEACHER: 'Новый преподаватель',
  ADMIN: 'Новый администратор',
};

export function AddUserModal({ isOpen, onClose, role, onSuccess }: AddUserModalProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const reset = () => {
    setFirstName(''); setLastName(''); setEmail(''); setUsername('');
    setPhone(''); setPassword(''); setError(''); setSuccess(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The user needs at least one way to log in.
    if (!email.trim() && !username.trim() && !phone.trim()) {
      setError('Укажите хотя бы один идентификатор для входа: email, телефон или никнейм');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await api.post('/users', {
        firstName, lastName, password, role,
        email: email.trim() || undefined,
        username: username.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setSuccess(true);
      setTimeout(() => {
        reset();
        onClose();
        onSuccess?.();
      }, 1500);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка при создании пользователя');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal open={isOpen} onOpenChange={(open) => { if (!open) { reset(); onClose(); } }}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle className="pr-8">{roleLabels[role]}</ModalTitle>
        </ModalHeader>

        {success ? (
          <ModalBody className="flex flex-col items-center py-10 text-center">
            <CheckCircle className="w-16 h-16 text-primary mb-4" />
            <h3 className="font-serif text-2xl font-bold mb-2 text-textPrimary">Успешно!</h3>
            <p className="text-textSecondary">Пользователь зарегистрирован.</p>
          </ModalBody>
        ) : (
          <form onSubmit={handleSubmit}>
            <ModalBody className="space-y-4">
              {error && (
                <div className="p-3 bg-danger/10 text-danger text-sm rounded-xl border border-danger/20">
                  {error}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">Имя</label>
                  <input required value={firstName} onChange={e => setFirstName(e.target.value)}
                    className="w-full p-3 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                    placeholder="Иван" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">Фамилия</label>
                  <input required value={lastName} onChange={e => setLastName(e.target.value)}
                    className="w-full p-3 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                    placeholder="Иванов" />
                </div>
              </div>
              <p className="text-xs text-textSecondary/70">
                Укажите хотя бы один способ входа: email, никнейм или телефон.
              </p>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">
                  Email <span className="normal-case text-textSecondary/50">(необязательно)</span>
                </label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  className="w-full p-3 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                  placeholder="user@example.com" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">
                  Никнейм <span className="normal-case text-textSecondary/50">(необязательно)</span>
                </label>
                <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                  className="w-full p-3 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                  placeholder="ivan_ivanov" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">
                  Телефон <span className="normal-case text-textSecondary/50">(необязательно)</span>
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                  <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                    className="w-full p-3 pl-9 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                    placeholder="+7 (999) 123-45-67" />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">Пароль</label>
                <input type="text" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full p-3 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                  placeholder={passwordMinLengthHint()} />
              </div>
            </ModalBody>
            <ModalFooter className="justify-end">
              <button type="button" onClick={() => { reset(); onClose(); }}
                className="px-5 py-3 rounded-xl font-bold text-textSecondary hover:bg-surfaceLow transition-colors text-sm">
                Отмена
              </button>
              <button type="submit" disabled={isLoading}
                className="px-5 py-3 rounded-xl bg-primary text-white font-bold flex items-center justify-center min-w-[120px] disabled:opacity-70 text-sm">
                {isLoading ? <Spinner /> : 'Создать'}
              </button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
