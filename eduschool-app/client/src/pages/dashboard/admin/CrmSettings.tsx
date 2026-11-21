import { useState, useRef, useEffect } from 'react';
import { Save, Upload, AlertTriangle, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Textarea } from '../../../components/ui/Textarea';
import api, { resolveUploadUrl } from '../../../lib/api';
import { usePermissions } from '../../../hooks/usePermissions';
import { useAuth } from '../../../hooks/useAuth';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';
import ConfirmModal from '../../../components/ui/ConfirmModal';
import ImportExport from './ImportExport';

// ─── Types & storage ──────────────────────────────────────────────────────────

interface GeneralSettings {
  name: string;
  address: string;
  phone: string;
  email: string;
  docLabel: string;
  logoUrl: string;
  heroImageUrl: string;
  description: string;
}

interface FinanceSettings {
  basePrice: number;
  billingDays: number;
  currency: string;
  defaultSalaryRate: number;
}

interface PauseSettings {
  allowed: boolean;
  maxDays: number | null;      // null = unlimited
  minNotice: number;
  timesPerYear: number | null; // null = unlimited
}

const GENERAL_DEFAULTS: GeneralSettings = { name: '', address: '', phone: '', email: '', docLabel: 'Квитанция', logoUrl: '', heroImageUrl: '', description: '' };

const FINANCE_DEFAULTS: FinanceSettings = {
  basePrice: 5000, billingDays: 26, currency: 'KGS',
  defaultSalaryRate: 800,
};

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surfaceLowest border border-border rounded-2xl p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-sm text-textPrimary">{title}</h3>
        {description && <p className="text-xs text-textSecondary mt-0.5">{description}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-textSecondary mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-textPrimary">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-border'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

// ── Single text-field card (view/edit, matches schedule tab cards) ────────────

function TextCard({
  title, description, value: initValue, placeholder, patchKey, onSaved,
}: {
  title: string;
  description?: string;
  value: string;
  placeholder?: string;
  patchKey: 'name' | 'address' | 'docLabel';
  onSaved: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initValue);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft(initValue); }, [initValue, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings/general', { [patchKey]: draft });
      toast.success('Сохранено');
      onSaved(draft);
      setEditing(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">{title}</h3>
            {description && <p className="text-xs text-textSecondary mt-0.5">{description}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">{initValue || '—'}</p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">{title}</h3>
      <Input value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder} />
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft(initValue); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ── Contacts card (phone + email together, view/edit) ─────────────────────────

function ContactsCard({
  phone: initPhone, email: initEmail, onSaved,
}: {
  phone: string;
  email: string;
  onSaved: (phone: string, email: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ phone: initPhone, email: initEmail });
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft({ phone: initPhone, email: initEmail }); }, [initPhone, initEmail, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings/general', { phone: draft.phone, email: draft.email });
      toast.success('Контакты сохранены');
      onSaved(draft.phone, draft.email);
      setEditing(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Контакты</h3>
            <p className="text-xs text-textSecondary mt-0.5">Телефон и email школы (для клиентов — не логин)</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">{initPhone || '—'} · {initEmail || '—'}</p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Контакты</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Телефон">
          <Input value={draft.phone} onChange={e => setDraft(p => ({ ...p, phone: e.target.value }))} placeholder="+996 700 000 000" />
        </Field>
        <Field label="Email">
          <Input value={draft.email} onChange={e => setDraft(p => ({ ...p, email: e.target.value }))} type="email" placeholder="info@school.kg" />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft({ phone: initPhone, email: initEmail }); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ── Branding card (public landing page logo/photo/description, OWNER-only) ────
// PATCH /schools/current/branding is hardcoded OWNER/SUPERADMIN-only server-side
// (narrower than settings:write, which ADMIN also holds) — mirrors the same
// canEditSchoolSettings-gated pattern ScheduleTab uses for its OWNER-only cards.

function ImagePickerSlot({ label, url, onPick, uploading }: {
  label: string;
  url: string;
  onPick: (file: File) => void;
  uploading: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resolved = resolveUploadUrl(url);
  return (
    <div>
      <label className="text-xs text-textSecondary mb-1 block">{label}</label>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="w-full aspect-video rounded-xl border-2 border-dashed border-border hover:border-primary/40 bg-surfaceLow flex items-center justify-center overflow-hidden transition disabled:opacity-50"
      >
        {resolved ? (
          <img src={resolved} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-xs text-textSecondary flex flex-col items-center gap-1">
            <Upload className="w-5 h-5" />
            {uploading ? 'Загрузка...' : 'Выбрать файл'}
          </span>
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => e.target.files?.[0] && onPick(e.target.files[0])}
      />
    </div>
  );
}

function BrandingCard({
  logoUrl: initLogoUrl, heroImageUrl: initHeroImageUrl, description: initDescription, onSaved,
}: {
  logoUrl: string;
  heroImageUrl: string;
  description: string;
  onSaved: (v: { logoUrl: string; heroImageUrl: string; description: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ logoUrl: initLogoUrl, heroImageUrl: initHeroImageUrl, description: initDescription });
  const [saving, setSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState<'logoUrl' | 'heroImageUrl' | null>(null);

  useEffect(() => {
    if (!editing) setDraft({ logoUrl: initLogoUrl, heroImageUrl: initHeroImageUrl, description: initDescription });
  }, [initLogoUrl, initHeroImageUrl, initDescription, editing]);

  async function handleUpload(field: 'logoUrl' | 'heroImageUrl', file: File) {
    setUploadingField(field);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await api.post('/upload', formData);
      const url = res.data?.data?.url;
      if (url) setDraft(d => ({ ...d, [field]: url }));
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка загрузки файла');
    } finally {
      setUploadingField(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/schools/current/branding', draft);
      toast.success('Брендинг сохранён');
      onSaved(draft);
      setEditing(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Лого и фото на сайте школы</h3>
            <p className="text-xs text-textSecondary mt-0.5">Показывается на публичной странице школы</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-4">
          <div className="w-12 h-12 rounded-lg overflow-hidden bg-surfaceLow border border-border flex items-center justify-center flex-shrink-0">
            {resolveUploadUrl(initLogoUrl) ? <img src={resolveUploadUrl(initLogoUrl)!} alt="" className="w-full h-full object-cover" /> : <span className="text-[10px] text-textSecondary">Лого</span>}
          </div>
          <div className="w-20 h-12 rounded-lg overflow-hidden bg-surfaceLow border border-border flex items-center justify-center flex-shrink-0">
            {resolveUploadUrl(initHeroImageUrl) ? <img src={resolveUploadUrl(initHeroImageUrl)!} alt="" className="w-full h-full object-cover" /> : <span className="text-[10px] text-textSecondary">Фото</span>}
          </div>
          <p className="text-sm text-textPrimary line-clamp-2">{initDescription || '—'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Лого и фото на сайте школы</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ImagePickerSlot label="Логотип" url={draft.logoUrl} uploading={uploadingField === 'logoUrl'} onPick={f => handleUpload('logoUrl', f)} />
        <ImagePickerSlot label="Фото для главной страницы" url={draft.heroImageUrl} uploading={uploadingField === 'heroImageUrl'} onPick={f => handleUpload('heroImageUrl', f)} />
      </div>
      <Field label="Описание школы">
        <Textarea
          value={draft.description}
          onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
          placeholder="Пара предложений о школе — покажется на публичной странице"
          maxLength={500}
        />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving || uploadingField !== null}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft({ logoUrl: initLogoUrl, heroImageUrl: initHeroImageUrl, description: initDescription }); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ─── General tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const { canEditSchoolSettings } = usePermissions();
  const [f, setF] = useState<GeneralSettings>(GENERAL_DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/settings/general').then(res => {
      const d = res.data?.data ?? {};
      setF({
        name:         d.name         ?? '',
        address:      d.address      ?? '',
        phone:        d.phone        ?? '',
        email:        d.email        ?? '',
        docLabel:     d.docLabel     ?? 'Квитанция',
        logoUrl:      d.logoUrl      ?? '',
        heroImageUrl: d.heroImageUrl ?? '',
        description:  d.description  ?? '',
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-textSecondary py-8 text-center">Загрузка...</p>;

  return (
    <div className="space-y-4">
      <TextCard
        title="Название школы"
        description="Отображается в квитанциях и уведомлениях"
        value={f.name}
        placeholder="Language School"
        patchKey="name"
        onSaved={name => setF(p => ({ ...p, name }))}
      />

      <TextCard
        title="Адрес"
        value={f.address}
        placeholder="ул. Примерная, 1"
        patchKey="address"
        onSaved={address => setF(p => ({ ...p, address }))}
      />

      <ContactsCard
        phone={f.phone}
        email={f.email}
        onSaved={(phone, email) => setF(p => ({ ...p, phone, email }))}
      />

      {canEditSchoolSettings && (
        <BrandingCard
          logoUrl={f.logoUrl}
          heroImageUrl={f.heroImageUrl}
          description={f.description}
          onSaved={v => setF(p => ({ ...p, ...v }))}
        />
      )}

      <TextCard
        title="Подпись документа (квитанции)"
        description="Заголовок, который выводится на квитанциях об оплате"
        value={f.docLabel}
        placeholder="Квитанция об оплате"
        patchKey="docLabel"
        onSaved={docLabel => setF(p => ({ ...p, docLabel }))}
      />
    </div>
  );
}

// ─── Finance tab ──────────────────────────────────────────────────────────────

// ── Tuition card (basePrice + billingDays, view/edit) ─────────────────────────

function TuitionCard({
  basePrice: initBasePrice, billingDays: initBillingDays, onSaved,
}: {
  basePrice: number;
  billingDays: number;
  onSaved: (basePrice: number, billingDays: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ basePrice: initBasePrice, billingDays: initBillingDays });
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft({ basePrice: initBasePrice, billingDays: initBillingDays }); }, [initBasePrice, initBillingDays, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings/finance', { basePrice: draft.basePrice, billingDays: draft.billingDays });
      toast.success('Сохранено');
      onSaved(draft.basePrice, draft.billingDays);
      setEditing(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  const pricePerLesson = (basePrice: number, billingDays: number) => Math.ceil(basePrice / (billingDays || 1));

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Студенческая оплата</h3>
            <p className="text-xs text-textSecondary mt-0.5">Базовые параметры расчёта стоимости обучения</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">
          {initBasePrice.toLocaleString()} сом/мес · {initBillingDays} дней в месяце
        </p>
        <p className="mt-1 text-xs text-textSecondary">
          Цена за урок: <strong className="text-textPrimary">{pricePerLesson(initBasePrice, initBillingDays)} сом</strong>
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Студенческая оплата</h3>
      <p className="text-xs text-textSecondary">
        Баланс студента — это уроки (кредиты). Дата «оплачено до» рассчитывается по расписанию: когда закончатся кредиты.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Базовая цена (сом/мес)">
          <Input type="number" value={draft.basePrice} onChange={e => setDraft(p => ({ ...p, basePrice: parseFloat(e.target.value) || 0 }))} />
        </Field>
        <Field label="Дней в расчётном месяце">
          <Input type="number" value={draft.billingDays} onChange={e => setDraft(p => ({ ...p, billingDays: parseFloat(e.target.value) || 0 }))} />
        </Field>
      </div>
      <p className="text-xs text-textSecondary">
        Цена за урок: <strong>{pricePerLesson(draft.basePrice, draft.billingDays)} сом</strong>
        &nbsp;·&nbsp;
        Половина: {Math.round(draft.basePrice / 2).toLocaleString()} сом = {Math.floor(Math.round(draft.basePrice / 2) / pricePerLesson(draft.basePrice, draft.billingDays))} уроков
      </p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft({ basePrice: initBasePrice, billingDays: initBillingDays }); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ── Default salary rate card (view/edit) ───────────────────────────────────────

function SalaryRateCard({
  defaultSalaryRate: initRate, onSaved,
}: {
  defaultSalaryRate: number;
  onSaved: (rate: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initRate);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft(initRate); }, [initRate, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings/finance', { defaultSalaryRate: draft });
      toast.success('Сохранено');
      onSaved(draft);
      setEditing(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Зарплата преподавателей</h3>
            <p className="text-xs text-textSecondary mt-0.5">Ставка по умолчанию для новых сотрудников</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">{initRate.toLocaleString()} сом/урок</p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Зарплата преподавателей</h3>
      <Field label="Ставка по умолчанию (сом/урок)">
        <Input type="number" value={draft} onChange={e => setDraft(parseFloat(e.target.value) || 0)} />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft(initRate); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

function FinanceTab() {
  const [f, setF] = useState<FinanceSettings>(FINANCE_DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/settings/finance').then(res => {
      const d = res.data?.data ?? {};
      setF({
        basePrice:         Number(d.basePrice)         || FINANCE_DEFAULTS.basePrice,
        billingDays:       Number(d.billingDays)       || FINANCE_DEFAULTS.billingDays,
        currency:          d.currency                  ?? FINANCE_DEFAULTS.currency,
        defaultSalaryRate: Number(d.defaultSalaryRate) || FINANCE_DEFAULTS.defaultSalaryRate,
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-textSecondary py-8 text-center">Загрузка...</p>;

  return (
    <div className="space-y-4">
      <TuitionCard
        basePrice={f.basePrice}
        billingDays={f.billingDays}
        onSaved={(basePrice, billingDays) => setF(p => ({ ...p, basePrice, billingDays }))}
      />

      <SalaryRateCard
        defaultSalaryRate={f.defaultSalaryRate}
        onSaved={defaultSalaryRate => setF(p => ({ ...p, defaultSalaryRate }))}
      />
    </div>
  );
}

// ─── Schedule settings tab ────────────────────────────────────────────────────

const TZ_OPTIONS = [
  { value: 'Asia/Almaty',   label: 'Asia/Almaty (Алма-Ата, +05:00)' },
  { value: 'Asia/Bishkek',  label: 'Asia/Bishkek (Бишкек, +06:00)' },
  { value: 'Asia/Tashkent', label: 'Asia/Tashkent (Ташкент, +05:00)' },
  { value: 'Asia/Dushanbe', label: 'Asia/Dushanbe (Душанбе, +05:00)' },
  { value: 'Europe/Moscow', label: 'Europe/Moscow (Москва, +03:00)' },
  { value: 'Europe/Kiev',   label: 'Europe/Kiev (Киев, +02:00 / +03:00)' },
  { value: 'Asia/Dubai',    label: 'Asia/Dubai (Дубай, +04:00)' },
  { value: 'Europe/London', label: 'Europe/London (Лондон, +00:00 / +01:00)' },
];

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

type AffectedGroup = {
  blockId: number;
  studentGroupId: number | null;
  groupName: string | null;
  level: string | null;
  type: string;
  reason: 'NON_WORKING_DAY' | 'OUTSIDE_WORK_HOURS';
  days: number[];
  startTime: string;
  endTime: string;
};

type PolicyImpact = {
  sessionsOutsideDays?: number;
  sessionsOutsideHours?: number;
  blocksOutsideDays?: number;
  blocksOutsideHours?: number;
  affectedBlockIds?: number[];
  affectedGroups?: AffectedGroup[];
  policyEffectiveFrom?: string;
  firstWorkingDate?: string;
};

function formatDateRu(isoStr: string | undefined): string {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

function SyncTimeSlotsButton() {
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      await api.post('/settings/sync-timeslots');
      toast.success('Слоты синхронизированы. Откройте расписание, чтобы проверить результат.');
    } catch {
      toast.error('Ошибка синхронизации слотов');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-surface border border-border rounded-xl">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-textSecondary mt-0.5">
          Используйте только если расписание показывает дублирующиеся или некорректные слоты.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={handleSync} isLoading={syncing} className="shrink-0">
        Исправить слоты расписания
      </Button>
    </div>
  );
}

// ── Policy impact modal ───────────────────────────────────────────────────────

function PolicyImpactModal({
  impact, saving, onConfirm, onClose,
}: {
  impact: PolicyImpact;
  saving: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { school, user } = useAuth();
  useBodyScrollLock();
  useBackButtonClose(true, onClose);
  const hasConflicts =
    (impact.sessionsOutsideDays ?? 0) > 0 ||
    (impact.sessionsOutsideHours ?? 0) > 0 ||
    (impact.blocksOutsideDays ?? 0) > 0 ||
    (impact.blocksOutsideHours ?? 0) > 0;
  const affectedGroups = impact.affectedGroups ?? [];

  function openInSchedule(g: AffectedGroup) {
    if (!school?.slug || !impact.firstWorkingDate) return;
    const rolePrefix = user?.role === 'OWNER' ? 'owner' : 'admin';
    const params = new URLSearchParams({
      focusBlockId: String(g.blockId),
      focusDate: impact.firstWorkingDate,
      focusStart: g.startTime,
      focusEnd: g.endTime,
    });
    if (g.studentGroupId != null) params.set('focusGroupId', String(g.studentGroupId));
    navigate(`/${school.slug}/${rolePrefix}/schedule?${params.toString()}`);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-white p-6 shadow-xl dark:bg-card max-h-[90dvh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-none text-orange-500" />
          <div>
            <h3 className="text-base font-bold text-textPrimary">Изменение политики расписания</h3>
            {impact.policyEffectiveFrom && (
              <p className="mt-1 text-sm font-semibold text-textPrimary">
                Новые настройки вступят в силу с {formatDateRu(impact.policyEffectiveFrom)}.
              </p>
            )}
            {impact.firstWorkingDate && (
              <p className="mt-0.5 text-sm text-textSecondary">
                Первый рабочий день по новой политике: {formatDateRu(impact.firstWorkingDate)}.
              </p>
            )}
          </div>
        </div>

        {hasConflicts && (
          <ul className="mb-4 space-y-1.5 rounded-lg border border-orange-100 bg-orange-50/60 p-3 text-sm dark:border-orange-900/40 dark:bg-orange-950/20">
            {(impact.sessionsOutsideDays ?? 0) > 0 && (
              <li className="text-orange-800 dark:text-orange-300">
                <strong>{impact.sessionsOutsideDays}</strong> занятий на нерабочих днях
              </li>
            )}
            {(impact.sessionsOutsideHours ?? 0) > 0 && (
              <li className="text-orange-800 dark:text-orange-300">
                <strong>{impact.sessionsOutsideHours}</strong> занятий вне рабочих часов
              </li>
            )}
            {(impact.blocksOutsideDays ?? 0) > 0 && (
              <li className="text-orange-800 dark:text-orange-300">
                <strong>{impact.blocksOutsideDays}</strong> блоков с днями вне политики
              </li>
            )}
            {(impact.blocksOutsideHours ?? 0) > 0 && (
              <li className="text-orange-800 dark:text-orange-300">
                <strong>{impact.blocksOutsideHours}</strong> блоков с временем вне рабочих часов
              </li>
            )}
            {(impact.affectedBlockIds?.length ?? 0) > 0 && (
              <li className="text-orange-600 text-xs dark:text-orange-400">
                Затронуто блоков: {impact.affectedBlockIds!.length}
              </li>
            )}
          </ul>
        )}

        {affectedGroups.length > 0 && (
          <ul className="mb-4 max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
            {affectedGroups.map(g => (
              <li
                key={g.blockId}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-textPrimary">
                    {g.groupName ?? `Группа #${g.studentGroupId ?? g.blockId}`}
                    {g.level ? ` · ${g.level}` : ''}
                  </p>
                  <p className="text-xs text-textSecondary">
                    {g.reason === 'NON_WORKING_DAY'
                      ? `${g.days.map(d => DAY_NAMES[d]).join('/')} — станет нерабочим днём`
                      : `${g.startTime}–${g.endTime} — вне новых рабочих часов`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openInSchedule(g)}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                >
                  Открыть
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-800 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-blue-300">
          Система не перенесёт и не отменит занятия автоматически.
          Конфликты отображаются в панели «Конфликты политики расписания».
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-textSecondary transition-colors hover:bg-surface"
          >
            Отмена
          </button>
          <Button variant="primary" onClick={onConfirm} isLoading={saving}>
            <Save className="w-3.5 h-3.5 mr-2" />
            Сохранить
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Timezone card (non-policy) ────────────────────────────────────────────────

function TimezoneCard({
  value: initValue,
  onSaved,
}: {
  value: string;
  onSaved: (tz: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initValue);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft(initValue); }, [initValue, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings', { timezone: draft });
      toast.success('Часовой пояс сохранён');
      onSaved(draft);
      setEditing(false);
    } catch {
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  const currentLabel = TZ_OPTIONS.find(o => o.value === initValue)?.label ?? initValue;

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Часовой пояс школы</h3>
            <p className="text-xs text-textSecondary mt-0.5">Все расписания и уведомления работают по этому времени</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">{currentLabel}</p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Часовой пояс школы</h3>
      <Field label="Часовой пояс">
        <select
          value={draft}
          onChange={e => setDraft(e.target.value)}
          className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          {TZ_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft(initValue); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ── Working hours + lesson duration card (policy-sensitive) ───────────────────

function WorkingHoursCard({
  workStart: initWS,
  workEnd: initWE,
  slotDuration: initSD,
  activeDays,
  onSaved,
}: {
  workStart: string;
  workEnd: string;
  slotDuration: number;
  activeDays: number[];
  onSaved: (workStart: string, workEnd: string, slotDuration: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ workStart: initWS, workEnd: initWE, slotDuration: initSD });
  const [saving, setSaving] = useState(false);
  const [impactLoading, setImpactLoading] = useState(false);
  const [showImpactModal, setShowImpactModal] = useState(false);
  const [pendingImpact, setPendingImpact] = useState<PolicyImpact | null>(null);

  useEffect(() => {
    if (!editing) setDraft({ workStart: initWS, workEnd: initWE, slotDuration: initSD });
  }, [initWS, initWE, initSD, editing]);

  function parseMin(t: string) {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function validate(): boolean {
    const wsMin = parseMin(draft.workStart);
    const weMin = parseMin(draft.workEnd);
    if (wsMin < 300) { toast.error('Начало рабочего дня не может быть раньше 05:00.'); return false; }
    if (weMin > 1380) { toast.error('Конец рабочего дня не может быть позже 23:00.'); return false; }
    if (wsMin >= weMin) { toast.error('Начало рабочего дня должно быть раньше конца.'); return false; }
    const slotCount = Math.floor((weMin - wsMin) / draft.slotDuration);
    if (slotCount > 32) { toast.error(`Слишком много слотов (${slotCount}). Уменьшите диапазон или увеличьте длительность.`); return false; }
    return true;
  }

  async function handleSaveClick() {
    if (!validate()) return;
    setImpactLoading(true);
    try {
      const res = await api.get('/settings/policy-impact', {
        params: { activeDays: activeDays.join(','), workStart: draft.workStart, workEnd: draft.workEnd },
      });
      setPendingImpact(res.data?.data ?? {});
      setShowImpactModal(true);
    } catch {
      await performSave();
    } finally {
      setImpactLoading(false);
    }
  }

  async function performSave() {
    setSaving(true);
    setShowImpactModal(false);
    try {
      await api.patch('/settings', {
        workStart: draft.workStart,
        workEnd: draft.workEnd,
        slotDuration: draft.slotDuration,
      });
      window.dispatchEvent(new CustomEvent('schedule-policy-updated'));
      toast.success('Рабочие часы сохранены');
      onSaved(draft.workStart, draft.workEnd, draft.slotDuration);
      setEditing(false);
    } catch {
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraft({ workStart: initWS, workEnd: initWE, slotDuration: initSD });
    setEditing(false);
    setShowImpactModal(false);
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Рабочие часы</h3>
            <p className="text-xs text-textSecondary mt-0.5">Время работы школы и длительность урока</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">
          {initWS} — {initWE} · {initSD} мин/урок
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold text-sm text-textPrimary">Рабочие часы</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Начало рабочего дня">
            <Input
              type="time" min="05:00" max="22:00"
              value={draft.workStart}
              onChange={e => setDraft(p => ({ ...p, workStart: e.target.value }))}
            />
          </Field>
          <Field label="Конец рабочего дня">
            <Input
              type="time" min="06:00" max="23:00"
              value={draft.workEnd}
              onChange={e => setDraft(p => ({ ...p, workEnd: e.target.value }))}
            />
          </Field>
        </div>
        <Field label="Длительность урока (минут)">
          <Select
            value={draft.slotDuration}
            onChange={e => setDraft(p => ({ ...p, slotDuration: parseInt(e.target.value) }))}
          >
            {[60, 75, 80, 90, 100, 120].map(d => (
              <option key={d} value={d}>{d} мин</option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={handleSaveClick}
            isLoading={saving || impactLoading}
          >
            <Save className="w-3.5 h-3.5 mr-2" />
            Сохранить
          </Button>
          <Button variant="outline" onClick={handleCancel} disabled={saving || impactLoading}>
            Отмена
          </Button>
        </div>
      </div>

      {showImpactModal && pendingImpact && (
        <PolicyImpactModal
          impact={pendingImpact}
          saving={saving}
          onConfirm={performSave}
          onClose={() => setShowImpactModal(false)}
        />
      )}
    </>
  );
}

// ── Working days card (policy-sensitive) ──────────────────────────────────────

function WorkingDaysCard({
  activeDays: initDays,
  workStart,
  workEnd,
  onSaved,
}: {
  activeDays: number[];
  workStart: string;
  workEnd: string;
  onSaved: (days: number[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number[]>(initDays);
  const [saving, setSaving] = useState(false);
  const [impactLoading, setImpactLoading] = useState(false);
  const [showImpactModal, setShowImpactModal] = useState(false);
  const [pendingImpact, setPendingImpact] = useState<PolicyImpact | null>(null);

  useEffect(() => { if (!editing) setDraft(initDays); }, [initDays, editing]);

  function toggleDay(di: number) {
    setDraft(prev =>
      prev.includes(di) ? prev.filter(d => d !== di) : [...prev, di].sort((a, b) => a - b)
    );
  }

  async function handleSaveClick() {
    if (draft.length === 0) { toast.error('Выберите хотя бы один рабочий день.'); return; }
    setImpactLoading(true);
    try {
      const res = await api.get('/settings/policy-impact', {
        params: { activeDays: draft.join(','), workStart, workEnd },
      });
      setPendingImpact(res.data?.data ?? {});
      setShowImpactModal(true);
    } catch {
      await performSave();
    } finally {
      setImpactLoading(false);
    }
  }

  async function performSave() {
    setSaving(true);
    setShowImpactModal(false);
    try {
      await api.patch('/settings', { activeDays: draft });
      window.dispatchEvent(new CustomEvent('schedule-policy-updated'));
      toast.success('Рабочие дни сохранены');
      onSaved(draft);
      setEditing(false);
    } catch {
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraft(initDays);
    setEditing(false);
    setShowImpactModal(false);
  }

  if (!editing) {
    const dayLabels = initDays.map(d => DAY_NAMES[d]).filter(Boolean).join(', ');
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Рабочие дни</h3>
            <p className="text-xs text-textSecondary mt-0.5">Дни недели, в которые школа работает</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">{dayLabels || 'Не задано'}</p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold text-sm text-textPrimary">Рабочие дни</h3>
        <div className="flex gap-2 flex-wrap">
          {DAY_NAMES.map((name, di) => (
            <button
              key={di}
              onClick={() => toggleDay(di)}
              className={`w-10 h-10 rounded-xl text-xs font-bold transition ${
                draft.includes(di)
                  ? 'bg-primary text-white'
                  : 'bg-surfaceLow text-textSecondary hover:bg-border'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={handleSaveClick}
            isLoading={saving || impactLoading}
            disabled={draft.length === 0}
          >
            <Save className="w-3.5 h-3.5 mr-2" />
            Сохранить
          </Button>
          <Button variant="outline" onClick={handleCancel} disabled={saving || impactLoading}>
            Отмена
          </Button>
        </div>
      </div>

      {showImpactModal && pendingImpact && (
        <PolicyImpactModal
          impact={pendingImpact}
          saving={saving}
          onConfirm={performSave}
          onClose={() => setShowImpactModal(false)}
        />
      )}
    </>
  );
}

// ── Default view card (non-policy) ────────────────────────────────────────────

function DefaultViewCard({
  defaultView: initView,
  onSaved,
}: {
  defaultView: 'week' | 'rooms';
  onSaved: (view: 'week' | 'rooms') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<'week' | 'rooms'>(initView);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft(initView); }, [initView, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings', { defaultView: draft });
      toast.success('Вид расписания сохранён');
      onSaved(draft);
      setEditing(false);
    } catch {
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  const viewLabel = initView === 'week' ? 'По времени' : 'По кабинетам';

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Вид расписания по умолчанию</h3>
            <p className="text-xs text-textSecondary mt-0.5">Какой вид открывается при входе в расписание</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">{viewLabel}</p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Вид расписания по умолчанию</h3>
      <Field label="Вид расписания">
        <Select
          value={draft}
          onChange={e => setDraft(e.target.value as 'week' | 'rooms')}
        >
          <option value="week">По времени</option>
          <option value="rooms">По кабинетам</option>
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft(initView); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ── Holidays card (non-policy) ────────────────────────────────────────────────

function HolidaysCard({
  holidays: initHolidays,
  onSaved,
}: {
  holidays: string[];
  onSaved: (holidays: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(initHolidays);
  const [newHoliday, setNewHoliday] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft(initHolidays); }, [initHolidays, editing]);

  function addHoliday() {
    if (!newHoliday || draft.includes(newHoliday)) return;
    setDraft(prev => [...prev, newHoliday].sort());
    setNewHoliday('');
  }

  function removeHoliday(date: string) {
    setDraft(prev => prev.filter(h => h !== date));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings', { holidays: draft });
      toast.success('Праздничные дни сохранены');
      onSaved(draft);
      setEditing(false);
    } catch {
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraft(initHolidays);
    setNewHoliday('');
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Праздничные и нерабочие дни</h3>
            <p className="text-xs text-textSecondary mt-0.5">Уроки не создаются в выбранные даты</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <div className="mt-3">
          {initHolidays.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {initHolidays.map(date => {
                const [y, m, d] = date.split('-');
                return (
                  <span key={date} className="text-xs px-2 py-1 bg-surface border border-border rounded-lg text-textPrimary">
                    {d}.{m}.{y}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-textSecondary">Праздничные дни не заданы</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Праздничные и нерабочие дни</h3>
      <div className="flex gap-2">
        <input
          type="date"
          value={newHoliday}
          onChange={e => setNewHoliday(e.target.value)}
          className="flex-1 text-sm border border-border rounded-xl px-3 py-2 bg-background text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <Button
          variant="outline"
          onClick={addHoliday}
          disabled={!newHoliday || draft.includes(newHoliday)}
        >
          + Добавить
        </Button>
      </div>
      {draft.length > 0 ? (
        <div className="space-y-1">
          {draft.map(date => {
            const [y, m, d] = date.split('-');
            return (
              <div key={date} className="flex items-center justify-between py-1.5 px-3 bg-background rounded-xl border border-border">
                <span className="text-sm text-textPrimary">{d}.{m}.{y}</span>
                <button
                  onClick={() => removeHoliday(date)}
                  className="text-xs text-red-500 hover:text-red-700 font-medium"
                >
                  Удалить
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-textSecondary">Праздничные дни не заданы</p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={handleCancel} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ─── Cabinets card ────────────────────────────────────────────────────────────

type Cabinet = { id: number; name: string; capacity: number; usageCount: number };

const byCabinetName = (a: Cabinet, b: Cabinet) => a.name.localeCompare(b.name);

function cabinetUsageLabel(n: number) {
  if (n === 0) return 'не используется';
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} занятие`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} занятия`;
  return `${n} занятий`;
}

function CabinetsCard() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newCapacity, setNewCapacity] = useState('15');
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Cabinet | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editCapacity, setEditCapacity] = useState('15');
  const [savingEdit, setSavingEdit] = useState(false);

  // Fetch on first expand only — the card is collapsed by default
  useEffect(() => {
    if (!open || loaded) return;
    api.get('/settings/cabinets')
      .then(res => { setCabinets(res.data?.data ?? []); setLoaded(true); })
      .catch(() => toast.error('Не удалось загрузить кабинеты'))
      .finally(() => setLoading(false));
  }, [open, loaded]);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      const res = await api.post('/settings/cabinets', { name, capacity: parseInt(newCapacity) || 15 });
      setCabinets(prev => [...prev, { ...res.data.data, usageCount: 0 }].sort(byCabinetName));
      setNewName('');
      setNewCapacity('15');
      toast.success('Кабинет добавлен');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Не удалось добавить кабинет');
    } finally {
      setAdding(false);
    }
  }

  function startEdit(cab: Cabinet) {
    setEditId(cab.id);
    setEditName(cab.name);
    setEditCapacity(String(cab.capacity));
  }

  async function handleEditSave() {
    const name = editName.trim();
    if (!name || editId === null) return;
    setSavingEdit(true);
    try {
      const res = await api.patch(`/settings/cabinets/${editId}`, { name, capacity: parseInt(editCapacity) || undefined });
      setCabinets(prev => prev.map(c => c.id === editId ? { ...c, ...res.data.data } : c).sort(byCabinetName));
      setEditId(null);
      toast.success('Кабинет обновлён');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Не удалось обновить кабинет');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete() {
    const target = deleteTarget;
    if (!target) return;
    try {
      await api.delete(`/settings/cabinets/${target.id}`);
      setCabinets(prev => prev.filter(c => c.id !== target.id));
      toast.success('Кабинет удалён');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Не удалось удалить кабинет');
    }
  }

  return (
    <div className="bg-surfaceLowest border border-border rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div>
          <h3 className="font-semibold text-sm text-textPrimary">Кабинеты</h3>
          <p className="text-xs text-textSecondary mt-0.5">Аудитории школы — используются в расписании и проверке коллизий</p>
        </div>
        <span className="text-textSecondary text-xs ml-3">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
      <div className="px-5 pb-5 space-y-4">
      {loading ? (
        <p className="text-xs text-textSecondary">Загрузка...</p>
      ) : (
        <>
          {cabinets.length > 0 ? (
            <div className="space-y-1">
              {cabinets.map(cab => cab.id === editId ? (
                <div key={cab.id} className="flex items-center gap-2 py-1.5 px-3 bg-background rounded-xl border border-primary/30">
                  <input
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="flex-1 min-w-0 text-sm border border-border rounded-xl px-3 py-1.5 bg-surfaceLowest text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <input
                    type="number"
                    min={1}
                    value={editCapacity}
                    onChange={e => setEditCapacity(e.target.value)}
                    title="Вместимость"
                    className="w-16 text-sm border border-border rounded-xl px-2 py-1.5 bg-surfaceLowest text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <Button variant="primary" size="sm" onClick={handleEditSave} disabled={!editName.trim()} isLoading={savingEdit}>
                    Сохранить
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditId(null)} disabled={savingEdit}>
                    Отмена
                  </Button>
                </div>
              ) : (
                <div key={cab.id} className="flex items-center justify-between py-1.5 px-3 bg-background rounded-xl border border-border">
                  <span className="text-sm text-textPrimary">{cab.name}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-textSecondary">до {cab.capacity} чел.</span>
                    <span className={`text-xs ${cab.usageCount > 0 ? 'text-textPrimary' : 'text-textSecondary'}`}>
                      {cabinetUsageLabel(cab.usageCount)}
                    </span>
                    <button
                      onClick={() => startEdit(cab)}
                      className="text-xs text-primary hover:brightness-110 font-medium"
                    >
                      Изменить
                    </button>
                    <button
                      onClick={() => setDeleteTarget(cab)}
                      className="text-xs text-red-500 hover:text-red-700 font-medium"
                    >
                      Удалить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-textSecondary">Кабинеты не добавлены</p>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Название (напр. 101)"
              className="flex-1 min-w-0 text-sm border border-border rounded-xl px-3 py-2 bg-background text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <input
              type="number"
              min={1}
              value={newCapacity}
              onChange={e => setNewCapacity(e.target.value)}
              title="Вместимость"
              className="w-20 text-sm border border-border rounded-xl px-3 py-2 bg-background text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <Button variant="outline" onClick={handleAdd} disabled={!newName.trim()} isLoading={adding}>
              + Добавить
            </Button>
          </div>
        </>
      )}
      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Удалить кабинет?"
        message={`Кабинет «${deleteTarget?.name}» будет удалён из списка. Кабинет, используемый в занятиях, удалить нельзя.`}
        confirmText="Удалить"
        isDanger
      />
      </div>
      )}
    </div>
  );
}

// ── ScheduleTab orchestrator ──────────────────────────────────────────────────

interface FullScheduleSettings {
  workStart: string;
  workEnd: string;
  slotDuration: number;
  activeDays: number[];
  defaultView: 'week' | 'rooms';
  timezone: string;
  holidays: string[];
}

const SCHEDULE_DEFAULTS: FullScheduleSettings = {
  workStart: '08:00',
  workEnd: '20:30',
  slotDuration: 80,
  activeDays: [0, 1, 2, 3, 4, 5],
  defaultView: 'week',
  timezone: 'Asia/Bishkek',
  holidays: [],
};

function ScheduleTab() {
  // Timezone/hours/days/default-view/holidays all save through PATCH /settings, which
  // has a hardcoded OWNER/SUPERADMIN-only check server-side (settings.ts) — ADMIN holds
  // settings:write but is explicitly excluded there. Cabinets and timeslot-sync are on
  // separate routes with a plain settings:write check, which ADMIN does have — those stay
  // available to ADMIN instead of being hidden along with the rest of this tab.
  const { canEditSchoolSettings } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<FullScheduleSettings>(SCHEDULE_DEFAULTS);
  const [showSlotsDiag, setShowSlotsDiag] = useState(false);

  useEffect(() => {
    api.get('/settings').then(res => {
      const d = res.data?.data ?? {};
      setSettings({
        workStart:    d.workStart    ?? SCHEDULE_DEFAULTS.workStart,
        workEnd:      d.workEnd      ?? SCHEDULE_DEFAULTS.workEnd,
        slotDuration: d.slotDuration ?? SCHEDULE_DEFAULTS.slotDuration,
        activeDays:   Array.isArray(d.activeDays) ? d.activeDays : SCHEDULE_DEFAULTS.activeDays,
        defaultView:  d.defaultView  ?? SCHEDULE_DEFAULTS.defaultView,
        timezone:     d.timezone     ?? SCHEDULE_DEFAULTS.timezone,
        holidays:     Array.isArray(d.holidays) ? d.holidays : [],
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-sm text-textSecondary py-8 text-center">Загрузка...</p>;
  }

  return (
    <div className="space-y-4">
      {canEditSchoolSettings && (
        <>
          <TimezoneCard
            value={settings.timezone}
            onSaved={tz => setSettings(p => ({ ...p, timezone: tz }))}
          />

          <WorkingHoursCard
            workStart={settings.workStart}
            workEnd={settings.workEnd}
            slotDuration={settings.slotDuration}
            activeDays={settings.activeDays}
            onSaved={(ws, we, sd) => setSettings(p => ({ ...p, workStart: ws, workEnd: we, slotDuration: sd }))}
          />

          <WorkingDaysCard
            activeDays={settings.activeDays}
            workStart={settings.workStart}
            workEnd={settings.workEnd}
            onSaved={days => setSettings(p => ({ ...p, activeDays: days }))}
          />

          <DefaultViewCard
            defaultView={settings.defaultView}
            onSaved={view => setSettings(p => ({ ...p, defaultView: view }))}
          />

          <HolidaysCard
            holidays={settings.holidays}
            onSaved={holidays => setSettings(p => ({ ...p, holidays }))}
          />
        </>
      )}

      <CabinetsCard />

      <div className="bg-surfaceLowest border border-border rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => setShowSlotsDiag(p => !p)}
          className="w-full flex items-center justify-between px-5 py-3 text-xs font-semibold text-textSecondary hover:text-textPrimary transition-colors"
        >
          <span>Диагностика слотов</span>
          <span className="text-textSecondary">{showSlotsDiag ? '▲' : '▼'}</span>
        </button>
        {showSlotsDiag && (
          <div className="px-5 pb-4">
            <SyncTimeSlotsButton />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Pause tab ────────────────────────────────────────────────────────────────

// ── Pause allowed card (toggle, view/edit) ─────────────────────────────────────

function PauseAllowedCard({
  allowed: initAllowed, onSaved,
}: {
  allowed: boolean;
  onSaved: (allowed: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initAllowed);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft(initAllowed); }, [initAllowed, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings/pause', { allowed: draft });
      toast.success('Сохранено');
      onSaved(draft);
      setEditing(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Пауза и заморозка</h3>
            <p className="text-xs text-textSecondary mt-0.5">Разрешить студентам ставить обучение на паузу</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">{initAllowed ? 'Разрешено' : 'Запрещено'}</p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Пауза и заморозка</h3>
      <Toggle label="Разрешить паузу" checked={draft} onChange={setDraft} />
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button variant="outline" onClick={() => { setDraft(initAllowed); setEditing(false); }} disabled={saving}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// ── Pause rules card (maxDays + minNotice + timesPerYear, view/edit) ──────────

function PauseRulesCard({
  maxDays: initMaxDays, minNotice: initMinNotice, timesPerYear: initTimesPerYear, onSaved,
}: {
  maxDays: number | null;
  minNotice: number;
  timesPerYear: number | null;
  onSaved: (maxDays: number | null, minNotice: number, timesPerYear: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ maxDays: initMaxDays, minNotice: initMinNotice, timesPerYear: initTimesPerYear });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft({ maxDays: initMaxDays, minNotice: initMinNotice, timesPerYear: initTimesPerYear });
  }, [initMaxDays, initMinNotice, initTimesPerYear, editing]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/settings/pause', {
        maxDays: draft.maxDays,
        minNotice: draft.minNotice,
        timesPerYear: draft.timesPerYear,
      });
      toast.success('Сохранено');
      onSaved(draft.maxDays, draft.minNotice, draft.timesPerYear);
      setEditing(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="bg-surfaceLowest border border-border rounded-2xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-sm text-textPrimary">Правила паузы</h3>
            <p className="text-xs text-textSecondary mt-0.5">Ограничения по длительности, срокам и частоте паузы</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Редактировать
          </Button>
        </div>
        <p className="mt-3 text-sm text-textPrimary">
          {initMaxDays === null ? 'Без ограничений по длительности' : `Макс. ${initMaxDays} дней`}
          {' · '}уведомление за {initMinNotice} дн.
          {' · '}{initTimesPerYear === null ? 'без ограничений по частоте' : `${initTimesPerYear} раз(а) в год`}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surfaceLowest border border-primary/30 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-sm text-textPrimary">Правила паузы</h3>
      <Field label="Макс. длительность паузы">
        <Select
          value={draft.maxDays === null ? '' : String(draft.maxDays)}
          onChange={e => setDraft(p => ({ ...p, maxDays: e.target.value === '' ? null : Number(e.target.value) }))}
        >
          <option value="7">7 дней</option>
          <option value="14">14 дней</option>
          <option value="30">30 дней</option>
          <option value="">Без ограничений</option>
        </Select>
      </Field>
      <Field label="Мин. дней уведомления до паузы">
        <Input
          type="number"
          min="0"
          value={draft.minNotice}
          onChange={e => setDraft(p => ({ ...p, minNotice: parseInt(e.target.value) || 0 }))}
        />
      </Field>
      <Field label="Пауз в год">
        <Select
          value={draft.timesPerYear === null ? '' : String(draft.timesPerYear)}
          onChange={e => setDraft(p => ({ ...p, timesPerYear: e.target.value === '' ? null : Number(e.target.value) }))}
        >
          <option value="1">1 раз</option>
          <option value="2">2 раза</option>
          <option value="3">3 раза</option>
          <option value="">Без ограничений</option>
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleSave} isLoading={saving}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Сохранить
        </Button>
        <Button
          variant="outline"
          onClick={() => { setDraft({ maxDays: initMaxDays, minNotice: initMinNotice, timesPerYear: initTimesPerYear }); setEditing(false); }}
          disabled={saving}
        >
          Отмена
        </Button>
      </div>
    </div>
  );
}

function PauseTab() {
  const [f, setF] = useState<PauseSettings>({ allowed: true, maxDays: 14, minNotice: 3, timesPerYear: 2 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/settings/pause').then(res => {
      const p = res.data?.data ?? {};
      setF({
        allowed:      p.allowed !== false,
        maxDays:      typeof p.maxDays === 'number' ? p.maxDays : null,
        minNotice:    typeof p.minNotice === 'number' ? p.minNotice : 3,
        timesPerYear: typeof p.timesPerYear === 'number' ? p.timesPerYear : null,
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-textSecondary py-8 text-center">Загрузка...</p>;

  return (
    <div className="space-y-4">
      <PauseAllowedCard
        allowed={f.allowed}
        onSaved={allowed => setF(p => ({ ...p, allowed }))}
      />

      <PauseRulesCard
        maxDays={f.maxDays}
        minNotice={f.minNotice}
        timesPerYear={f.timesPerYear}
        onSaved={(maxDays, minNotice, timesPerYear) => setF(p => ({ ...p, maxDays, minNotice, timesPerYear }))}
      />
    </div>
  );
}

// ─── Stub section ─────────────────────────────────────────────────────────────

function StubTab({ name }: { name: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-textSecondary text-sm">Раздел «{name}» — в разработке</p>
    </div>
  );
}

// ─── Advanced tab ──────────────────────────────────────────────────────────────

function AdvancedTab({ isOwner }: { isOwner: boolean }) {
  const { school } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [confirmInput, setConfirmInput] = useState('');
  const [inputError, setInputError] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function openStep2() {
    setStep(2);
    setConfirmInput('');
    setInputError(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function cancel() {
    setStep(0);
    setConfirmInput('');
    setInputError(false);
  }

  async function execute() {
    if (confirmInput.trim() !== 'CLEAR') {
      setInputError(true);
      inputRef.current?.focus();
      return;
    }
    setLoading(true);
    try {
      await api.delete('/settings/clear-all-data', { data: { reason: 'Ручная очистка данных владельцем школы' } });
      toast.success('Все данные очищены');
      // Clear all bios UI-preference localStorage keys
      Object.keys(localStorage)
        .filter(k => k.startsWith('bios_'))
        .forEach(k => localStorage.removeItem(k));
      setTimeout(() => { navigate(`/${school?.slug}/owner/dashboard`); }, 1200);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Ошибка при очистке данных');
      setStep(0);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">

      {/* Импорт / Экспорт */}
      <Section
        title="Импорт / Экспорт"
        description="Перенос данных — импорт студентов и преподавателей из CSV/Excel, экспорт в удобные форматы."
      >
        <div className="flex items-center gap-2 text-textSecondary mb-2">
          <Upload className="w-4 h-4 text-primary flex-shrink-0" />
        </div>
        <ImportExport embedded />
      </Section>

      {/* Опасная зона — только для OWNER */}
      {isOwner && (
        <div className="bg-surfaceLowest border border-red-200 dark:border-red-900/50 rounded-2xl overflow-hidden">
          <div className="bg-red-50 dark:bg-red-950/20 px-5 py-3 border-b border-red-200 dark:border-red-900/50">
            <h3 className="font-semibold text-sm text-red-700 dark:text-red-400">Опасная зона</h3>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-xs text-textSecondary leading-relaxed">
              Это удалит все данные о студентах, учителях, расписании и других записях.
              Кабинеты, тайм-слоты и аккаунты администраторов сохранятся.
              Это действие нельзя отменить.
            </p>

            {step === 0 && (
              <Button
                variant="outline"
                className="border-red-400 text-red-600 hover:bg-red-50"
                onClick={() => setStep(1)}
              >
                Очистить все данные
              </Button>
            )}

            {step === 1 && (
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900/50">
                  <span className="text-base mt-0.5">⚠</span>
                  <p className="text-xs text-red-700 dark:text-red-400 leading-relaxed">
                    Вы уверены? Все студенты, преподаватели и учебные записи будут удалены навсегда.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={cancel}>Отмена</Button>
                  <Button
                    size="sm"
                    className="bg-red-600 hover:bg-red-700 text-white border-0"
                    onClick={openStep2}
                  >
                    Продолжить
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <p className="text-xs text-textSecondary">
                  Введите <span className="font-mono font-bold text-red-600">CLEAR</span> для подтверждения
                </p>
                <input
                  ref={inputRef}
                  type="text"
                  value={confirmInput}
                  onChange={e => { setConfirmInput(e.target.value); setInputError(false); }}
                  onKeyDown={e => e.key === 'Enter' && execute()}
                  placeholder="CLEAR"
                  className={`w-full text-sm border rounded-xl px-3 py-2 bg-background text-textPrimary font-mono tracking-widest focus:outline-none focus:ring-2 ${
                    inputError
                      ? 'border-red-500 focus:ring-red-300'
                      : 'border-border focus:ring-primary/30'
                  }`}
                />
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={cancel} disabled={loading}>Отмена</Button>
                  <Button
                    size="sm"
                    className="bg-red-600 hover:bg-red-700 text-white border-0"
                    onClick={execute}
                    isLoading={loading}
                  >
                    Очистить всё
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CrmSettings page ─────────────────────────────────────────────────────────

type SettingsTab = 'general' | 'finance' | 'schedule' | 'pause' | 'notifs' | 'advanced';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'Общие' },
  { id: 'finance', label: 'Финансы' },
  { id: 'schedule', label: 'Расписание' },
  { id: 'pause', label: 'Пауза' },
  { id: 'notifs', label: 'Уведомления' },
  { id: 'advanced', label: 'Дополнительно' },
];

// Tabs whose mutations are entirely OWNER-only on the server (PATCH /settings/finance
// enforces an explicit OWNER check) — a non-owner can't change anything there, so they
// don't see the tab at all (no dead editor that 403s on save). "Расписание" is NOT in
// this list even though most of its fields are owner-only (PATCH /settings) — cabinets
// and timeslot-sync on that same tab use a plain settings:write check ADMIN does hold,
// so ScheduleTab() itself splits by field instead of the whole tab being hidden.
const OWNER_ONLY_TABS: SettingsTab[] = ['finance'];

export default function CrmSettings() {
  const { canClearData } = usePermissions();
  const isOwner = canClearData;
  const visibleTabs = isOwner ? TABS : TABS.filter(t => !OWNER_ONLY_TABS.includes(t.id));
  const [tab, setTab] = useState<SettingsTab>('general');

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-serif text-2xl text-textPrimary">Настройки CRM</h1>
      </div>

      {/* Mobile nav — horizontal scrollable tab bar (hidden on desktop) */}
      <div className="md:hidden overflow-x-auto scroll-fade-x -mx-4 px-4">
        <div className="flex gap-0 border-b border-border/50 min-w-max">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-xs font-bold uppercase tracking-widest border-b-2 -mb-px whitespace-nowrap transition ${
                tab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-textSecondary hover:text-textPrimary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Two-column layout: vertical nav + content */}
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6 md:gap-8 items-start">
        {/* Desktop nav — vertical pill list (hidden on mobile) */}
        <nav className="hidden md:flex md:flex-col gap-1 md:sticky md:top-5">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors ${
                tab === t.id
                  ? 'bg-surface text-textPrimary font-semibold'
                  : 'text-textSecondary hover:bg-surface/60 hover:text-textPrimary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div className="min-w-0 md:border-l md:border-border md:pl-8">
          {tab === 'general' && <GeneralTab />}
          {tab === 'finance' && <FinanceTab />}
          {tab === 'schedule' && <ScheduleTab />}
          {tab === 'pause' && <PauseTab />}
          {tab === 'notifs' && <StubTab name="Уведомления" />}
          {tab === 'advanced' && <AdvancedTab isOwner={isOwner} />}
        </div>
      </div>
    </div>
  );
}
