import React, { useState } from 'react';
import { CheckCircle, Mail, Phone, User, Shield } from 'lucide-react';
import api from '../../lib/api';
import { Spinner } from './Spinner';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, ModalTitle } from './Modal';

interface InviteUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function InviteUserModal({ isOpen, onClose, onSuccess }: InviteUserModalProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'TEACHER'>('TEACHER');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const reset = () => {
    setEmail('');
    setRole('TEACHER');
    setFirstName('');
    setLastName('');
    setPhone('');
    setError('');
    setSuccess(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !role) {
      setError('Email и роль обязательны для заполнения.');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      await api.post('/invites', {
        email: email.toLowerCase().trim(),
        role,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        phone: phone.trim() || undefined
      });

      setSuccess(true);
      setTimeout(() => {
        reset();
        onClose();
        onSuccess?.();
      }, 1500);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка при отправке приглашения.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal open={isOpen} onOpenChange={(open) => { if (!open) { reset(); onClose(); } }}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle className="pr-8">Пригласить сотрудника</ModalTitle>
        </ModalHeader>

        {success ? (
          <ModalBody className="flex flex-col items-center py-10 text-center">
            <CheckCircle className="w-16 h-16 text-primary mb-4 animate-bounce" />
            <h3 className="font-serif text-2xl font-bold mb-2 text-textPrimary">Отправлено!</h3>
            <p className="text-textSecondary">Приглашение на {email} успешно отправлено.</p>
          </ModalBody>
        ) : (
          <form onSubmit={handleSubmit}>
            <ModalBody className="space-y-4">
              {error && (
                <div className="p-3 bg-danger/10 text-danger text-sm rounded-xl border border-danger/20">
                  {error}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                  <input 
                    type="email" 
                    required 
                    value={email} 
                    onChange={e => setEmail(e.target.value)}
                    className="w-full p-3 pl-9 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                    placeholder="user@example.com" 
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">Роль</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setRole('TEACHER')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-black uppercase tracking-widest transition ${
                      role === 'TEACHER'
                        ? 'bg-primary/5 border-primary text-primary'
                        : 'border-border bg-surfaceLow text-textSecondary hover:text-textPrimary'
                    }`}
                  >
                    <User className="w-4 h-4" />
                    Преподаватель
                  </button>
                  <button
                    type="button"
                    onClick={() => setRole('ADMIN')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-black uppercase tracking-widest transition ${
                      role === 'ADMIN'
                        ? 'bg-primary/5 border-primary text-primary'
                        : 'border-border bg-surfaceLow text-textSecondary hover:text-textPrimary'
                    }`}
                  >
                    <Shield className="w-4 h-4" />
                    Администратор
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">Имя (необязательно)</label>
                  <input 
                    value={firstName} 
                    onChange={e => setFirstName(e.target.value)}
                    className="w-full p-3 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                    placeholder="Иван" 
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">Фамилия (необязательно)</label>
                  <input 
                    value={lastName} 
                    onChange={e => setLastName(e.target.value)}
                    className="w-full p-3 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                    placeholder="Иванов" 
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest font-bold text-textSecondary">
                  Телефон <span className="normal-case text-textSecondary/50">(необязательно)</span>
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary pointer-events-none" />
                  <input 
                    type="tel" 
                    value={phone} 
                    onChange={e => setPhone(e.target.value)}
                    className="w-full p-3 pl-9 bg-surfaceLow rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
                    placeholder="+7 (999) 123-45-67" 
                  />
                </div>
              </div>
            </ModalBody>
            <ModalFooter className="justify-end">
              <button 
                type="button" 
                onClick={() => { reset(); onClose(); }}
                className="px-5 py-3 rounded-xl font-bold text-textSecondary hover:bg-surfaceLow transition-colors text-sm"
              >
                Отмена
              </button>
              <button 
                type="submit" 
                disabled={isLoading || !email}
                className="px-5 py-3 rounded-xl bg-primary text-white font-bold flex items-center justify-center min-w-[120px] disabled:opacity-50 text-sm"
              >
                {isLoading ? <Spinner /> : 'Отправить'}
              </button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
