import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import api from '../lib/api';
import { Spinner } from '../components/ui/Spinner';
import { 
  CheckCircle2, 
  ChevronLeft, 
  Compass, 
  Shield, 
  ArrowRight, 
  LayoutGrid, 
  Users, 
  School as SchoolIcon,
  HelpCircle,
  Phone,
  MapPin,
  Clock,
  DollarSign
} from 'lucide-react';

interface Cabinet {
  id?: number;
  name: string;
  capacity?: number;
}

interface Invite {
  id?: number;
  email: string;
  role: 'ADMIN' | 'TEACHER';
  firstName?: string;
  lastName?: string;
  phone?: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string;
}

export default function OwnerOnboarding() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { school, logout } = useAuth();
  
  // App loading & saving states
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [activeStep, setActiveStep] = useState('basic-info');

  // Step 1: Basic Info
  const [schoolName, setSchoolName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [timezone, setTimezone] = useState('Asia/Bishkek');
  const [currency, setCurrency] = useState('KGS');

  // Step 2: Learning Format
  const [centerType, setCenterType] = useState('language_school'); // language_school, educational_center, online_school
  const [classFormat, setClassFormat] = useState('both'); // individual, group, both
  const [workFormat, setWorkFormat] = useState('offline'); // offline, online, hybrid

  // Step 3: Cabinets
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [newCabName, setNewCabName] = useState('');
  const [newCabCapacity, setNewCabCapacity] = useState('15');
  const [cabError, setCabError] = useState('');
  const [cabLoading, setCabLoading] = useState(false);

  // Step 4: Subjects
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);
  const [customSubject, setCustomSubject] = useState('');

  // Step 5: Team
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'TEACHER'>('TEACHER');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState('');

  useEffect(() => {
    const initData = async () => {
      setLoading(true);
      setError('');
      try {
        const [statusRes, settingsRes, financeRes, cabinetsRes, invitesRes] = await Promise.all([
          api.get('/onboarding/status'),
          api.get('/settings').catch(() => null),
          api.get('/settings/finance').catch(() => null),
          api.get('/settings/cabinets').catch(() => null),
          api.get('/invites').catch(() => null)
        ]);

        if (statusRes.data.success) {
          const statusData = statusRes.data.data;
          setActiveStep(statusData.onboardingStep || 'basic-info');
          
          if (statusData.onboardingCompleted) {
            navigate(`/${slug}/owner/dashboard`, { replace: true });
            return;
          }
        }

        if (settingsRes?.data?.success) {
          const settings = settingsRes.data.data;
          setSchoolName(settings.name || school?.name || '');
          setPhone(settings.phone || school?.phone || '');
          setCity(settings.city || school?.city || '');
          setTimezone(settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Bishkek');
          
          if (settings.learningFormat) {
            setCenterType(settings.learningFormat.type || 'language_school');
            setClassFormat(settings.learningFormat.classFormat || 'both');
            setWorkFormat(settings.learningFormat.workFormat || 'offline');
          }
          if (settings.subjects) {
            setSelectedSubjects(settings.subjects);
          }
        } else {
          setSchoolName(school?.name || '');
          setPhone(school?.phone || '');
          setCity(school?.city || '');
          setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Bishkek');
        }

        if (financeRes?.data?.success) {
          setCurrency(financeRes.data.data.currency || 'KGS');
        }

        if (cabinetsRes?.data?.success) {
          setCabinets(cabinetsRes.data.data);
        }

        if (invitesRes?.data?.success) {
          setInvites(invitesRes.data.data);
        }
      } catch (err: any) {
        console.error('Error initializing onboarding data:', err);
        setError(err.response?.data?.error || 'Не удалось загрузить данные онбординга. Пожалуйста, обновите страницу.');
      } finally {
        setLoading(false);
      }
    };

    initData();
  }, [slug, navigate, school]);

  const handleAddCabinet = async () => {
    if (!newCabName.trim()) return;
    setCabLoading(true);
    setCabError('');
    try {
      const res = await api.post('/settings/cabinets', {
        name: newCabName.trim(),
        capacity: parseInt(newCabCapacity) || 15
      });
      if (res.data.success) {
        setCabinets([...cabinets, res.data.data]);
        setNewCabName('');
        setNewCabCapacity('15');
      }
    } catch (err: any) {
      console.error('Error adding cabinet:', err);
      setCabError(err.response?.data?.error || err.response?.data?.message || 'Не удалось создать кабинет. Возможно, имя уже занято.');
    } finally {
      setCabLoading(false);
    }
  };

  const handleSendInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviteLoading(true);
    setInviteError('');
    setInviteSuccess('');
    try {
      const res = await api.post('/invites', {
        email: inviteEmail.trim().toLowerCase(),
        role: inviteRole,
        firstName: inviteFirstName.trim() || undefined,
        lastName: inviteLastName.trim() || undefined,
        phone: invitePhone.trim() || undefined
      });
      if (res.data.success) {
        setInvites([res.data.data.invite, ...invites]);
        setInviteEmail('');
        setInviteFirstName('');
        setInviteLastName('');
        setInvitePhone('');
        setInviteSuccess(`Приглашение успешно отправлено на ${inviteEmail}`);
      }
    } catch (err: any) {
      console.error('Error sending invite:', err);
      setInviteError(err.response?.data?.error || 'Не удалось отправить приглашение. Проверьте правильность email.');
    } finally {
      setInviteLoading(false);
    }
  };

  const handleNext = async () => {
    setError('');
    setSaving(true);
    try {
      if (activeStep === 'basic-info') {
        if (!schoolName.trim()) {
          setError('Название школы обязательно для заполнения');
          setSaving(false);
          return;
        }
        
        // 1. PATCH /settings — Save timezone, activeDays, school name, phone, city
        await api.patch('/settings', {
          name: schoolName,
          phone: phone || undefined,
          city: city || undefined,
          timezone,
          activeDays: [0, 1, 2, 3, 4, 5],
          workStart: '08:00',
          workEnd: '22:00',
          slotDuration: 60
        });

        // 2. PATCH /settings/finance — Save currency
        await api.patch('/settings/finance', {
          currency
        });

        // 3. Save Step status on backend
        await api.post('/onboarding/save-step', { step: 'format' });
        setActiveStep('format');
      } else if (activeStep === 'format') {
        // 1. PATCH /settings — Save center format in JSON settings
        await api.patch('/settings', {
          learningFormat: {
            type: centerType,
            classFormat,
            workFormat
          }
        });

        // 2. Save Step status on backend
        await api.post('/onboarding/save-step', { step: 'cabinets' });
        setActiveStep('cabinets');
      } else if (activeStep === 'cabinets') {
        // Cabinets are saved in real-time, just update state step
        await api.post('/onboarding/save-step', { step: 'subjects' });
        setActiveStep('subjects');
      } else if (activeStep === 'subjects') {
        // 1. PATCH /settings — Save subjects array in JSON settings
        await api.patch('/settings', {
          subjects: selectedSubjects
        });

        // 2. Save Step status on backend
        await api.post('/onboarding/save-step', { step: 'team' });
        setActiveStep('team');
      } else if (activeStep === 'team') {
        // Invites are saved in real-time, just update state step
        await api.post('/onboarding/save-step', { step: 'complete' });
        setActiveStep('complete');
      } else if (activeStep === 'complete') {
        // Complete Onboarding on backend
        const res = await api.post('/onboarding/complete');
        if (res.data.success) {
          // Force fully reloading auth session to pick up onboardingCompleted: true
          window.location.href = `/${slug}/owner/dashboard`;
        }
      }
    } catch (err: any) {
      console.error('Error saving onboarding step:', err);
      setError(err.response?.data?.error || 'Не удалось сохранить настройки. Пожалуйста, попробуйте еще раз.');
    } finally {
      setSaving(false);
    }
  };

  const handleBack = () => {
    setError('');
    if (activeStep === 'format') setActiveStep('basic-info');
    else if (activeStep === 'cabinets') setActiveStep('format');
    else if (activeStep === 'subjects') setActiveStep('cabinets');
    else if (activeStep === 'team') setActiveStep('subjects');
    else if (activeStep === 'complete') setActiveStep('team');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-surface">
        <div className="flex flex-col items-center gap-4">
          <Spinner />
          <p className="text-sm font-medium text-textSecondary animate-pulse">Загрузка конфигуратора школы...</p>
        </div>
      </div>
    );
  }

  const steps = [
    { id: 'basic-info', label: 'Основные данные школы', desc: 'Название, телефон, валюта и часовой пояс', icon: SchoolIcon },
    { id: 'format', label: 'Формат обучения', desc: 'Учебные программы, онлайн или офлайн занятия', icon: Compass },
    { id: 'cabinets', label: 'Филиалы и кабинеты', desc: 'Физические классы для составления расписания', icon: LayoutGrid, optional: true },
    { id: 'subjects', label: 'Направления / предметы', desc: 'Языковые уровни и предметы обучения', icon: Shield, optional: true },
    { id: 'team', label: 'Команда', desc: 'Приглашение преподавателей и администраторов', icon: Users, optional: true },
    { id: 'complete', label: 'Завершение', desc: 'Готово к запуску вашей новой CRM-системы', icon: CheckCircle2 }
  ];

  const activeIndex = steps.findIndex(s => s.id === activeStep);
  const currentStep = steps[activeIndex !== -1 ? activeIndex : 0];

  const getNextButtonText = () => {
    if (activeStep === 'complete') return 'Перейти в CRM';
    if (currentStep.optional) {
      if (activeStep === 'cabinets' && cabinets.length === 0) return 'Пропустить шаг';
      if (activeStep === 'subjects' && selectedSubjects.length === 0) return 'Пропустить шаг';
      if (activeStep === 'team' && invites.length === 0) return 'Пропустить шаг';
    }
    return 'Сохранить и продолжить';
  };

  return (
    <div className="bg-background text-surface min-h-screen flex flex-col font-sans relative overflow-hidden">
      {/* Dynamic Background Gradients */}
      <div className="fixed top-[-10%] left-[-10%] w-[45%] h-[45%] bg-primaryContainer/20 rounded-full blur-[140px] -z-10 pointer-events-none" />
      <div className="fixed bottom-[-5%] right-[-5%] w-[35%] h-[35%] bg-primary/10 rounded-full blur-[120px] -z-10 pointer-events-none" />

      {/* Navigation Header */}
      <header className="w-full flex justify-between items-center px-8 py-6 max-w-7xl mx-auto border-b border-border/30">
        <div className="flex items-center gap-3">
          <span className="text-xl font-serif font-bold text-primary">Shamdan</span>
          <span className="text-[10px] uppercase tracking-widest font-semibold px-2 py-0.5 bg-primary/10 text-primary rounded-full">
            Setup Wizard
          </span>
        </div>
        <button
          onClick={logout}
          className="text-xs font-semibold text-textSecondary hover:text-surface transition-colors duration-200 border border-border px-4 py-2 rounded-xl hover:bg-surfaceLow/50"
        >
          Выйти из аккаунта
        </button>
      </header>

      {/* Main Container */}
      <main className="flex-grow flex items-center justify-center px-6 py-12 max-w-6xl mx-auto w-full">
        <div className="grid md:grid-cols-5 gap-10 items-stretch w-full">
          
          {/* Left panel: Info & Wizard Steps */}
          <div className="md:col-span-2 flex flex-col justify-center space-y-8 pr-0 md:pr-4">
            <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <h1 className="font-serif text-3xl font-extrabold text-surface tracking-tight leading-tight md:text-4xl">
                Настроим вашу школу
              </h1>
              <p className="text-textSecondary text-xs leading-relaxed max-w-sm">
                Несколько быстрых шагов, чтобы CRM-платформа {school?.name ? `«${school.name}»` : ''} сразу была готова к полноценной работе.
              </p>
            </div>

            {/* Steps Progress List */}
            <div className="space-y-2.5 animate-in fade-in slide-in-from-bottom-6 duration-700">
              {steps.map((step, idx) => {
                const StepIcon = step.icon;
                const isCompleted = idx < activeIndex;
                const isActive = idx === activeIndex;
                
                return (
                  <div
                    key={step.id}
                    className={`flex items-start gap-3 p-3 rounded-2xl border transition duration-300 ${
                      isActive
                        ? 'bg-surfaceLow border-primary/30 shadow-md scale-[1.01]'
                        : isCompleted
                        ? 'bg-surfaceLowest/40 border-border/20 opacity-80'
                        : 'bg-transparent border-transparent opacity-50'
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors duration-300 ${
                        isCompleted
                          ? 'bg-primary/20 text-primary'
                          : isActive
                          ? 'bg-primary text-white shadow-[0_4px_12px_rgba(var(--color-primary),0.2)]'
                          : 'bg-surfaceLow border border-border text-textSecondary'
                      }`}
                    >
                      {isCompleted ? <CheckCircle2 size={16} /> : <StepIcon size={16} />}
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <h3
                          className={`text-xs font-bold transition-colors ${
                            isActive ? 'text-surface' : 'text-textSecondary'
                          }`}
                        >
                          {step.label}
                        </h3>
                        {step.optional && (
                          <span className="text-[8px] font-semibold bg-surfaceLow text-textSecondary border border-border px-1.5 py-0.5 rounded">
                            Опционально
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-textSecondary/75 font-normal leading-normal">{step.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right panel: Active Step Content Card */}
          <div className="md:col-span-3 flex items-center animate-in fade-in zoom-in-95 duration-500">
            <div className="bg-surfaceLowest rounded-3xl p-8 md:p-10 border border-border shadow-[0_16px_40px_-6px_rgba(45,52,50,0.05)] w-full relative min-h-[500px] flex flex-col justify-between">
              <div className="absolute top-0 right-0 w-24 h-24 bg-primary/5 rounded-bl-[100px] -z-10" />
              
              {/* Step Title */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] tracking-widest font-extrabold uppercase text-primary">
                    Шаг {activeIndex + 1} из {steps.length}
                  </span>
                  {currentStep.optional && (
                    <span className="text-[9px] font-extrabold uppercase tracking-wider text-textSecondary flex items-center gap-1">
                      <HelpCircle size={10} />
                      Можно пропустить
                    </span>
                  )}
                </div>
                <h2 className="text-xl font-bold text-surface">{currentStep.label}</h2>
                <p className="text-xs text-textSecondary leading-relaxed">{currentStep.desc}</p>
                <div className="w-full bg-border rounded-full h-1 overflow-hidden mt-2">
                  <div
                    className="bg-primary h-full rounded-full transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.round(((activeIndex + 1) / steps.length) * 100)}%` }}
                  />
                </div>
              </div>

              {/* Error Box */}
              {error && (
                <div className="p-3 bg-danger/10 border-l-4 border-danger rounded-r-xl my-4">
                  <p className="text-danger text-xs font-semibold">{error}</p>
                </div>
              )}

              {/* Form Body - Step Content Switch */}
              <div className="flex-grow py-6 flex flex-col justify-center">
                {activeStep === 'basic-info' && (
                  <div className="space-y-4 animate-in fade-in duration-300">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider flex items-center gap-1">
                        <SchoolIcon size={12} className="text-primary" />
                        Название школы *
                      </label>
                      <input
                        type="text"
                        value={schoolName}
                        onChange={(e) => setSchoolName(e.target.value)}
                        className="w-full px-4 py-3 bg-surfaceLow/60 border border-border/60 rounded-xl focus:border-primary/60 focus:ring-2 focus:ring-primary/20 outline-none text-sm transition"
                        placeholder="Например, Cambridge Academy"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-textSecondary uppercase tracking-wider flex items-center gap-1">
                          <Phone size={12} className="text-primary" />
                          Телефон
                        </label>
                        <input
                          type="text"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          className="w-full px-4 py-3 bg-surfaceLow/60 border border-border/60 rounded-xl focus:border-primary/60 focus:ring-2 focus:ring-primary/20 outline-none text-sm transition"
                          placeholder="+996 555 123 456"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-textSecondary uppercase tracking-wider flex items-center gap-1">
                          <MapPin size={12} className="text-primary" />
                          Город
                        </label>
                        <input
                          type="text"
                          value={city}
                          onChange={(e) => setCity(e.target.value)}
                          className="w-full px-4 py-3 bg-surfaceLow/60 border border-border/60 rounded-xl focus:border-primary/60 focus:ring-2 focus:ring-primary/20 outline-none text-sm transition"
                          placeholder="Например, Бишкек"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-textSecondary uppercase tracking-wider flex items-center gap-1">
                          <Clock size={12} className="text-primary" />
                          Часовой пояс *
                        </label>
                        <div className="relative">
                          <select
                            value={timezone}
                            onChange={(e) => setTimezone(e.target.value)}
                            className="w-full px-4 py-3 bg-surfaceLow/60 border border-border/60 rounded-xl focus:border-primary/60 focus:ring-2 focus:ring-primary/20 outline-none text-sm transition appearance-none cursor-pointer text-surface"
                          >
                            <option value="Asia/Bishkek">Asia/Bishkek (Бишкек)</option>
                            <option value="Asia/Almaty">Asia/Almaty (Алматы)</option>
                            <option value="Asia/Tashkent">Asia/Tashkent (Ташкент)</option>
                            <option value="Europe/Moscow">Europe/Moscow (Москва)</option>
                            <option value="UTC">UTC (Универсальное время)</option>
                          </select>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-textSecondary uppercase tracking-wider flex items-center gap-1">
                          <DollarSign size={12} className="text-primary" />
                          Валюта *
                        </label>
                        <div className="relative">
                          <select
                            value={currency}
                            onChange={(e) => setCurrency(e.target.value)}
                            className="w-full px-4 py-3 bg-surfaceLow/60 border border-border/60 rounded-xl focus:border-primary/60 focus:ring-2 focus:ring-primary/20 outline-none text-sm transition appearance-none cursor-pointer text-surface"
                          >
                            <option value="KGS">KGS (сом)</option>
                            <option value="KZT">KZT (тенге)</option>
                            <option value="UZS">UZS (сум)</option>
                            <option value="RUB">RUB (рубль)</option>
                            <option value="USD">USD (доллар)</option>
                            <option value="EUR">EUR (евро)</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeStep === 'format' && (
                  <div className="space-y-5 animate-in fade-in duration-300">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider block">Тип учебного центра</label>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { id: 'language_school', label: 'Языковая школа', desc: 'Курсы языков' },
                          { id: 'educational_center', label: 'Учебный центр', desc: 'Предметы и курсы' },
                          { id: 'online_school', label: 'Онлайн-школа', desc: 'Только онлайн' }
                        ].map(t => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setCenterType(t.id)}
                            className={`p-3 rounded-xl border text-left flex flex-col justify-between transition duration-300 min-h-[75px] ${
                              centerType === t.id
                                ? 'border-primary bg-primary/5 shadow-md'
                                : 'border-border/60 bg-surfaceLow/40 hover:bg-surfaceLow/80'
                            }`}
                          >
                            <span className={`text-xs font-bold ${centerType === t.id ? 'text-primary' : 'text-surface'}`}>{t.label}</span>
                            <span className="text-[9px] text-textSecondary mt-1 leading-tight">{t.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider block">Формат занятий</label>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { id: 'individual', label: 'Индивидуальные', desc: '1 на 1 с учителем' },
                          { id: 'group', label: 'Групповые', desc: 'Занятия в группах' },
                          { id: 'both', label: 'Индивид. + Групп.', desc: 'Смешанный формат' }
                        ].map(t => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setClassFormat(t.id)}
                            className={`p-3 rounded-xl border text-left flex flex-col justify-between transition duration-300 min-h-[75px] ${
                              classFormat === t.id
                                ? 'border-primary bg-primary/5 shadow-md'
                                : 'border-border/60 bg-surfaceLow/40 hover:bg-surfaceLow/80'
                            }`}
                          >
                            <span className={`text-xs font-bold ${classFormat === t.id ? 'text-primary' : 'text-surface'}`}>{t.label}</span>
                            <span className="text-[9px] text-textSecondary mt-1 leading-tight">{t.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider block">Формат работы</label>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { id: 'offline', label: 'Офлайн', desc: 'В физ. кабинетах' },
                          { id: 'online', label: 'Онлайн', desc: 'Через видеосвязь' },
                          { id: 'hybrid', label: 'Гибрид', desc: 'Офлайн + Онлайн' }
                        ].map(t => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setWorkFormat(t.id)}
                            className={`p-3 rounded-xl border text-left flex flex-col justify-between transition duration-300 min-h-[75px] ${
                              workFormat === t.id
                                ? 'border-primary bg-primary/5 shadow-md'
                                : 'border-border/60 bg-surfaceLow/40 hover:bg-surfaceLow/80'
                            }`}
                          >
                            <span className={`text-xs font-bold ${workFormat === t.id ? 'text-primary' : 'text-surface'}`}>{t.label}</span>
                            <span className="text-[9px] text-textSecondary mt-1 leading-tight">{t.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {activeStep === 'cabinets' && (
                  <div className="space-y-4 animate-in fade-in duration-300">
                    <div className="bg-surfaceLow/30 border border-border/40 rounded-2xl p-4 space-y-3 shadow-sm">
                      <h3 className="text-xs font-bold text-surface uppercase tracking-wider">Добавить новый кабинет</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <input
                          type="text"
                          placeholder="Название (напр., Аудитория 1)"
                          value={newCabName}
                          onChange={(e) => setNewCabName(e.target.value)}
                          className="px-3 py-2.5 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface"
                        />
                        <input
                          type="number"
                          placeholder="Вместимость (по умолчанию 15)"
                          value={newCabCapacity}
                          onChange={(e) => setNewCabCapacity(e.target.value)}
                          className="px-3 py-2.5 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface"
                        />
                      </div>
                      {cabError && <p className="text-[10px] font-semibold text-danger">{cabError}</p>}
                      <button
                        type="button"
                        onClick={handleAddCabinet}
                        disabled={cabLoading || !newCabName.trim()}
                        className="w-full py-2.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl font-bold text-xs transition flex justify-center items-center gap-1 disabled:opacity-50"
                      >
                        {cabLoading ? <Spinner /> : 'Создать кабинет'}
                      </button>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider">Физические кабинеты ({cabinets.length})</label>
                      {cabinets.length === 0 ? (
                        <div className="text-center py-6 border border-dashed border-border/50 rounded-2xl bg-surfaceLow/10 text-textSecondary text-xs">
                          Кабинеты еще не созданы. Добавьте кабинеты для ведения расписания или пропустите.
                        </div>
                      ) : (
                        <div className="max-h-[140px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                          {cabinets.map((cab, idx) => (
                            <div key={idx} className="flex justify-between items-center px-4 py-2.5 bg-surfaceLow/40 border border-border/30 rounded-xl">
                              <span className="text-xs font-bold text-surface">{cab.name}</span>
                              <span className="text-[9px] bg-border/40 text-textSecondary px-2.5 py-0.5 rounded-full font-semibold">
                                Вместимость: {cab.capacity ?? 15}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeStep === 'subjects' && (
                  <div className="space-y-4 animate-in fade-in duration-300">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider block">Быстрый выбор направлений обучения</label>
                      <div className="flex flex-wrap gap-2 max-h-[140px] overflow-y-auto pr-1">
                        {[
                          'Английский', 'Немецкий', 'Корейский', 'Китайский',
                          'Французский', 'Русский', 'Математика', 'IELTS / TOEFL'
                        ].map(subj => {
                          const isSelected = selectedSubjects.includes(subj);
                          return (
                            <button
                              key={subj}
                              type="button"
                              onClick={() => {
                                if (isSelected) {
                                  setSelectedSubjects(selectedSubjects.filter(s => s !== subj));
                                } else {
                                  setSelectedSubjects([...selectedSubjects, subj]);
                                }
                              }}
                              className={`px-3.5 py-2 rounded-full text-xs font-semibold border transition duration-300 ${
                                isSelected
                                  ? 'bg-primary text-white border-primary shadow-sm'
                                  : 'bg-surfaceLow/40 text-textSecondary border-border/60 hover:bg-surfaceLow/80'
                              }`}
                            >
                              {subj}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-border/30">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider block">Добавить своё направление</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="Например, Программирование"
                          value={customSubject}
                          onChange={(e) => setCustomSubject(e.target.value)}
                          className="flex-grow px-3 py-2 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (customSubject.trim() && !selectedSubjects.includes(customSubject.trim())) {
                              setSelectedSubjects([...selectedSubjects, customSubject.trim()]);
                              setCustomSubject('');
                            }
                          }}
                          className="px-4 py-2 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl font-bold text-xs transition border border-primary/20"
                        >
                          Добавить
                        </button>
                      </div>
                    </div>
                    
                    {selectedSubjects.length > 0 && (
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-textSecondary uppercase tracking-wider">Выбранные предметы ({selectedSubjects.length}):</label>
                        <div className="flex flex-wrap gap-1.5 max-h-[80px] overflow-y-auto pr-1">
                          {selectedSubjects.map(s => (
                            <span key={s} className="px-2 py-0.5 bg-surfaceLow text-surface rounded-md text-[10px] font-medium border border-border flex items-center gap-1">
                              {s}
                              <button
                                type="button"
                                onClick={() => setSelectedSubjects(selectedSubjects.filter(item => item !== s))}
                                className="text-textSecondary hover:text-danger text-[9px] font-extrabold ml-0.5"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeStep === 'team' && (
                  <div className="space-y-4 animate-in fade-in duration-300">
                    <div className="bg-surfaceLow/30 border border-border/40 rounded-2xl p-4 space-y-3 shadow-sm">
                      <h3 className="text-xs font-bold text-surface uppercase tracking-wider">Отправить приглашение сотруднику</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <input
                          type="email"
                          placeholder="Email *"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          className="px-3 py-2.5 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface"
                        />
                        <select
                          value={inviteRole}
                          onChange={(e) => setInviteRole(e.target.value as 'ADMIN' | 'TEACHER')}
                          className="px-3 py-2.5 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface cursor-pointer"
                        >
                          <option value="TEACHER">Преподаватель</option>
                          <option value="ADMIN">Администратор</option>
                        </select>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3">
                        <input
                          type="text"
                          placeholder="Имя"
                          value={inviteFirstName}
                          onChange={(e) => setInviteFirstName(e.target.value)}
                          className="px-3 py-2 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface"
                        />
                        <input
                          type="text"
                          placeholder="Фамилия"
                          value={inviteLastName}
                          onChange={(e) => setInviteLastName(e.target.value)}
                          className="px-3 py-2 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface"
                        />
                      </div>

                      <input
                        type="text"
                        placeholder="Телефон"
                        value={invitePhone}
                        onChange={(e) => setInvitePhone(e.target.value)}
                        className="w-full px-3 py-2 bg-surfaceLow/60 border border-border/60 rounded-xl text-xs outline-none focus:border-primary transition text-surface"
                      />

                      {inviteError && <p className="text-[10px] font-semibold text-danger">{inviteError}</p>}
                      {inviteSuccess && <p className="text-[10px] font-semibold text-primary">{inviteSuccess}</p>}

                      <button
                        type="button"
                        onClick={handleSendInvite}
                        disabled={inviteLoading || !inviteEmail.trim()}
                        className="w-full py-2.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl font-bold text-xs transition flex justify-center items-center gap-1 disabled:opacity-50"
                      >
                        {inviteLoading ? <Spinner /> : 'Отправить приглашение'}
                      </button>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-textSecondary uppercase tracking-wider flex justify-between items-center">
                        <span>Список отправленных приглашений ({invites.length})</span>
                      </label>
                      {invites.length === 0 ? (
                        <div className="text-center py-5 border border-dashed border-border/50 rounded-2xl bg-surfaceLow/10 text-textSecondary text-xs">
                          Приглашения не отправлялись. Команда может быть приглашена позже в настройках CRM.
                        </div>
                      ) : (
                        <div className="max-h-[100px] overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                          {invites.map((inv, idx) => (
                            <div key={idx} className="flex justify-between items-center px-4 py-2 bg-surfaceLow/40 border border-border/30 rounded-xl">
                              <div className="flex flex-col min-w-0">
                                <span className="text-xs font-bold text-surface truncate">{inv.email}</span>
                                {(inv.firstName || inv.lastName) && (
                                  <span className="text-[8px] text-textSecondary truncate">{inv.firstName} {inv.lastName}</span>
                                )}
                              </div>
                              <span className="text-[8px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold uppercase shrink-0">
                                {inv.role === 'ADMIN' ? 'Админ' : 'Учитель'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeStep === 'complete' && (
                  <div className="space-y-5 animate-in fade-in duration-500 text-center py-4">
                    <div className="w-14 h-14 bg-primary/20 text-primary rounded-full flex items-center justify-center mx-auto animate-bounce">
                      <CheckCircle2 size={30} />
                    </div>
                    <div className="space-y-1">
                      <h2 className="text-xl font-bold font-serif text-surface">Поздравляем! Настройка завершена</h2>
                      <p className="text-[10px] text-textSecondary max-w-sm mx-auto">
                        Все базовые настройки вашей организации успешно сохранены. Ваша школа готова к первому запуску CRM!
                      </p>
                    </div>

                    <div className="bg-surfaceLow/30 border border-border/50 rounded-2xl p-4 text-left space-y-2.5 max-w-md mx-auto shadow-inner">
                      <h3 className="text-[10px] font-bold text-surface uppercase tracking-wider border-b border-border/40 pb-1.5 flex justify-between items-center">
                        <span>Итоги первичной настройки</span>
                        <span className="text-[8px] text-primary lowercase tracking-normal">ready for launch</span>
                      </h3>
                      <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-[10px]">
                        <div className="flex flex-col min-w-0">
                          <span className="text-textSecondary text-[8px] font-semibold uppercase">Школа</span>
                          <span className="font-bold text-surface truncate">{schoolName || school?.name}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-textSecondary text-[8px] font-semibold uppercase">Часовой пояс</span>
                          <span className="font-bold text-surface">{timezone}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-textSecondary text-[8px] font-semibold uppercase">Валюта</span>
                          <span className="font-bold text-surface">{currency}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-textSecondary text-[8px] font-semibold uppercase">Создано кабинетов</span>
                          <span className="font-bold text-surface">{cabinets.length}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-textSecondary text-[8px] font-semibold uppercase">Направлений</span>
                          <span className="font-bold text-surface">{selectedSubjects.length}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-textSecondary text-[8px] font-semibold uppercase">Приглашено коллег</span>
                          <span className="font-bold text-surface">{invites.length}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Wizard Controls Footer */}
              <div className="flex gap-4 pt-4 border-t border-border/30">
                {activeStep !== 'basic-info' && (
                  <button
                    type="button"
                    onClick={handleBack}
                    disabled={saving}
                    className="flex-1 py-3 bg-surfaceLow border border-border/80 text-textSecondary rounded-xl font-bold text-xs flex justify-center items-center gap-1.5 transition hover:bg-surfaceLow/80 disabled:opacity-50 shrink-0 max-w-[120px]"
                  >
                    <ChevronLeft size={14} />
                    Назад
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={saving || (activeStep === 'basic-info' && !schoolName.trim())}
                  className="flex-grow py-3 bg-primary text-white rounded-xl font-extrabold text-xs transition duration-300 hover:opacity-90 hover:shadow-[0_8px_20px_-4px_rgba(var(--color-primary),0.3)] active:scale-[0.98] flex justify-center items-center gap-1.5 disabled:opacity-50"
                >
                  {saving ? (
                    <Spinner />
                  ) : (
                    <>
                      {getNextButtonText()}
                      {activeStep === 'complete' ? <CheckCircle2 size={14} /> : <ArrowRight size={14} />}
                    </>
                  )}
                </button>
              </div>

            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
