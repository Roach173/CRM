import { useEffect, useState } from 'react';
import { User, KeyRound, Phone, Pencil, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../hooks/useAuth';
import api from '../lib/api';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { MIN_PASSWORD_LENGTH, passwordMinLengthHint } from '../lib/passwordPolicy';

const ROLE_LABELS: Record<string, string> = {
  OWNER:      'Исполнительный директор',
  ADMIN:      'Администратор',
  TEACHER:    'Преподаватель',
  STUDENT:    'Студент',
  SUPERADMIN: 'Суперадмин',
};

// ── Имя и фамилия (view/edit card — matches Настройки школы → Общие) ──────────

function NameCard({ firstName, lastName, onSaved }: {
  firstName: string;
  lastName: string;
  onSaved: (firstName: string, lastName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ firstName, lastName });
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft({ firstName, lastName }); }, [firstName, lastName, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/users/me', draft);
      toast.success('Сохранено');
      onSaved(draft.firstName, draft.lastName);
      setEditing(false);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-3xl border border-border/20 p-8 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">
            <User size={16} />
          </div>
          <h2 className="text-base font-bold text-surface">Имя и фамилия</h2>
        </div>
        {!editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        )}
      </div>

      {editing ? (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Имя" value={draft.firstName} onChange={e => setDraft(d => ({ ...d, firstName: e.target.value }))} />
            <Input label="Фамилия" value={draft.lastName} onChange={e => setDraft(d => ({ ...d, lastName: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} isLoading={saving} size="sm">
              <Save className="w-3.5 h-3.5 mr-2" />
              Сохранить
            </Button>
            <Button variant="outline" onClick={() => { setDraft({ firstName, lastName }); setEditing(false); }} disabled={saving} size="sm">
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-textPrimary">{firstName} {lastName}</p>
      )}
    </div>
  );
}

// ── Контакты: email + телефон (view/edit card) ────────────────────────────────

function ContactCard({ email, phone, onSaved }: {
  email: string;
  phone: string;
  onSaved: (email: string, phone: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ email, phone });
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft({ email, phone }); }, [email, phone, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/users/me', draft);
      toast.success('Сохранено');
      onSaved(draft.email, draft.phone);
      setEditing(false);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-3xl border border-border/20 p-8 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">
            <Phone size={16} />
          </div>
          <div>
            <h2 className="text-base font-bold text-surface">Контакты</h2>
            <p className="text-xs text-textSecondary mt-0.5">Email и телефон — используются для входа и связи</p>
          </div>
        </div>
        {!editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        )}
      </div>

      {editing ? (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Email" type="email" value={draft.email} onChange={e => setDraft(d => ({ ...d, email: e.target.value }))} />
            <Input label="Телефон" type="tel" placeholder="+996..." value={draft.phone} onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} isLoading={saving} size="sm">
              <Save className="w-3.5 h-3.5 mr-2" />
              Сохранить
            </Button>
            <Button variant="outline" onClick={() => { setDraft({ email, phone }); setEditing(false); }} disabled={saving} size="sm">
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-textPrimary">{email || '—'} · {phone || '—'}</p>
      )}
    </div>
  );
}

export default function Profile() {
  const { user } = useAuth();

  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase();

  const [name, setName] = useState({ firstName: user?.firstName ?? '', lastName: user?.lastName ?? '' });
  const [contact, setContact] = useState({ email: user?.email ?? '', phone: user?.phone ?? '' });

  useEffect(() => {
    if (!user) return;
    setName({ firstName: user.firstName, lastName: user.lastName });
    setContact({ email: user.email, phone: user.phone ?? '' });
  }, [user]);

  // ── Change password ──────────────────────────────────────────────────────────
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' });
  const [pwdError, setPwdError] = useState('');
  const [savingPwd, setSavingPwd] = useState(false);

  async function handleSavePassword() {
    setPwdError('');
    if (!pwd.current || !pwd.next) {
      setPwdError('Заполните все поля');
      return;
    }
    if (pwd.next !== pwd.confirm) {
      setPwdError('Пароли не совпадают');
      return;
    }
    if (pwd.next.length < MIN_PASSWORD_LENGTH) {
      setPwdError(passwordMinLengthHint());
      return;
    }
    setSavingPwd(true);
    try {
      await api.patch('/users/me/password', {
        currentPassword: pwd.current,
        newPassword:     pwd.next,
      });
      toast.success('Пароль изменён');
      setPwd({ current: '', next: '', confirm: '' });
    } catch (err: any) {
      setPwdError(err?.response?.data?.error ?? 'Ошибка смены пароля');
    } finally {
      setSavingPwd(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 md:px-10 py-12 min-h-screen bg-background space-y-8">

      {/* Header */}
      <div>
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary mb-3 block">
          Аккаунт
        </span>
        <h1 className="text-5xl font-serif text-surface font-light leading-tight tracking-tight">
          Мой профиль
        </h1>
      </div>

      {/* Hero card */}
      <div className="bg-white rounded-3xl border border-border/20 p-8 shadow-sm flex items-center gap-6">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center text-primary font-black text-xl flex-shrink-0">
          {initials}
        </div>
        <div>
          <p className="text-xl font-bold text-surface">
            {user?.firstName} {user?.lastName}
          </p>
          <p className="text-sm text-textSecondary mt-0.5">{user?.email}</p>
          <span className="inline-block mt-2 text-[10px] font-black uppercase tracking-widest text-primary bg-primary/10 px-3 py-1 rounded-full">
            {ROLE_LABELS[user?.role ?? ''] ?? user?.role}
          </span>
        </div>
      </div>

      <NameCard
        firstName={name.firstName}
        lastName={name.lastName}
        onSaved={(firstName, lastName) => setName({ firstName, lastName })}
      />

      <ContactCard
        email={contact.email}
        phone={contact.phone}
        onSaved={(email, phone) => setContact({ email, phone })}
      />

      {/* Change password */}
      <div className="bg-white rounded-3xl border border-border/20 p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <KeyRound size={16} />
          </div>
          <h2 className="text-base font-bold text-surface">Смена пароля</h2>
        </div>

        <div className="space-y-4 mb-6">
          <Input
            label="Текущий пароль"
            type="password"
            value={pwd.current}
            onChange={e => setPwd(p => ({ ...p, current: e.target.value }))}
          />
          <Input
            label="Новый пароль"
            type="password"
            value={pwd.next}
            onChange={e => setPwd(p => ({ ...p, next: e.target.value }))}
          />
          <Input
            label="Повторите новый пароль"
            type="password"
            value={pwd.confirm}
            onChange={e => setPwd(p => ({ ...p, confirm: e.target.value }))}
            error={pwdError}
          />
        </div>

        <Button onClick={handleSavePassword} isLoading={savingPwd} size="sm">
          Изменить пароль
        </Button>
      </div>

    </div>
  );
}
