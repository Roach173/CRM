import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../../lib/api';
import SuperAdminLayout from '../../../components/layout/SuperAdminLayout';
import SearchInput from '../../../components/ui/SearchInput';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';
import { X, Users, GraduationCap, ShieldCheck, MapPin, Mail, Building2, ShieldOff, ShieldCheck as ShieldOn, AlertTriangle, CreditCard } from 'lucide-react';

function subStatusLabel(status?: string | null) {
  switch (status) {
    case 'TRIALING':     return { label: 'Trial', cls: 'bg-blue-100 text-blue-700' };
    case 'GRACE_PERIOD': return { label: 'Grace', cls: 'bg-amber-100 text-amber-700' };
    case 'ACTIVE':  return { label: 'Активна', cls: 'bg-green-100 text-green-700' };
    case 'OVERDUE': return { label: 'Просрочена', cls: 'bg-amber-100 text-amber-700' };
    case 'BLOCKED': return { label: 'Заблокирована', cls: 'bg-red-100 text-red-700' };
    default:        return { label: 'Нет подписки', cls: 'bg-surfaceLow text-textSecondary' };
  }
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SuperAdminSchools() {
  const [schools, setSchools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedSchool, setSelectedSchool] = useState<any>(null);
  useBodyScrollLock(!!selectedSchool);
  const [schoolDetail, setSchoolDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendDays, setExtendDays] = useState('30');
  const [extending, setExtending] = useState(false);

  const [selectedPlan, setSelectedPlan] = useState('STARTER');
  const [markingPaid, setMarkingPaid] = useState(false);
  const [blockingSub, setBlockingSub] = useState(false);

  useBackButtonClose(!!selectedSchool, () => { setSelectedSchool(null); setConfirmBlock(false); setExtendOpen(false); });

  useEffect(() => {
    fetchSchools();
  }, []);

  const fetchSchools = async () => {
    try {
      const res = await api.get('/superadmin/schools');
      setSchools(res.data.data);
    } catch { /* intentional */ } finally {
      setLoading(false);
    }
  };

  const fetchSchoolDetail = async (id: number) => {
    setDetailLoading(true);
    try {
      const res = await api.get(`/superadmin/schools/${id}`);
      setSchoolDetail(res.data.data);
    } catch { /* intentional */ } finally {
      setDetailLoading(false);
    }
  };

  const handleToggleActive = async () => {
    if (!selectedSchool) return;
    setToggling(true);
    try {
      const res = await api.patch(`/superadmin/schools/${selectedSchool.id}/toggle-active`);
      const newIsActive = res.data.isActive;

      // обновляем список карточек
      setSchools(prev => prev.map(s =>
        s.id === selectedSchool.id ? { ...s, isActive: newIsActive } : s
      ));
      // обновляем открытую панель
      setSelectedSchool((prev: any) => ({ ...prev, isActive: newIsActive }));
      setConfirmBlock(false);
    } catch {
      toast.error('Не удалось изменить статус школы');
    } finally {
      setToggling(false);
    }
  };

  const handleExtend = async () => {
    if (!selectedSchool) return;
    const days = parseInt(extendDays);
    if (!days || days < 1) {
      toast.error('Введите корректное число дней');
      return;
    }
    setExtending(true);
    try {
      const res = await api.patch(`/subscriptions/${selectedSchool.id}/extend`, { days, plan: selectedPlan });
      const newSub = res.data.data;
      const updatedSchool = {
        ...selectedSchool,
        subscription: {
          status: newSub.status,
          plan: newSub.plan,
          trialEndsAt: newSub.trialEndsAt,
          paidUntil: newSub.paidUntil
        }
      };
      setSchools(prev => prev.map(s =>
        s.id === selectedSchool.id ? updatedSchool : s
      ));
      setSelectedSchool(updatedSchool);
      toast.success(`Подписка продлена на ${days} дней`);
      setExtendOpen(false);
    } catch {
      toast.error('Не удалось продлить подписку');
    } finally {
      setExtending(false);
    }
  };

  const handleMarkPaid = async () => {
    if (!selectedSchool) return;
    const days = parseInt(extendDays);
    if (!days || days < 1) {
      toast.error('Введите корректное число дней');
      return;
    }
    setMarkingPaid(true);
    try {
      const res = await api.patch(`/subscriptions/${selectedSchool.id}/mark-paid`, { days, plan: selectedPlan });
      const newSub = res.data.data;
      const updatedSchool = {
        ...selectedSchool,
        subscription: {
          status: newSub.status,
          plan: newSub.plan,
          trialEndsAt: newSub.trialEndsAt,
          paidUntil: newSub.paidUntil
        }
      };
      setSchools(prev => prev.map(s =>
        s.id === selectedSchool.id ? updatedSchool : s
      ));
      setSelectedSchool(updatedSchool);
      toast.success('Оплата успешно зарегистрирована');
      setExtendOpen(false);
    } catch {
      toast.error('Не удалось зафиксировать оплату');
    } finally {
      setMarkingPaid(false);
    }
  };

  const handleBlockSubscription = async () => {
    if (!selectedSchool) return;
    setBlockingSub(true);
    try {
      const res = await api.patch(`/subscriptions/${selectedSchool.id}/block`);
      const newSub = res.data.data;
      const updatedSchool = {
        ...selectedSchool,
        subscription: {
          status: newSub.status,
          plan: newSub.plan,
          trialEndsAt: newSub.trialEndsAt,
          paidUntil: newSub.paidUntil
        }
      };
      setSchools(prev => prev.map(s =>
        s.id === selectedSchool.id ? updatedSchool : s
      ));
      setSelectedSchool(updatedSchool);
      toast.success('Подписка принудительно заблокирована ✗');
    } catch {
      toast.error('Не удалось заблокировать подписку');
    } finally {
      setBlockingSub(false);
    }
  };

  const filteredSchools = schools.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.city.toLowerCase().includes(search.toLowerCase())
  );

  const isBlocked = selectedSchool && selectedSchool.isActive === false;

  return (
    <SuperAdminLayout>
      <div className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h1 className="font-serif text-2xl text-textPrimary">Образовательные учреждения</h1>

        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Поиск по названию или городу..."
          className="w-80"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSchools.map(school => (
            <div
              key={school.id}
              onClick={() => {
                setSelectedSchool(school);
                setSelectedPlan(school.subscription?.plan || 'STARTER');
                setConfirmBlock(false);
                fetchSchoolDetail(school.id);
              }}
              className={`rounded-[2.5rem] p-8 border shadow-sm hover:border-primary/20 transition cursor-pointer group flex flex-col h-full relative ${
                school.isActive === false
                  ? 'bg-red-50/60 border-red-200/40 opacity-70'
                  : 'bg-surfaceLowest border-border/5'
              }`}
            >
              <div className="absolute top-4 right-4 flex flex-col items-end gap-1.5">
                {school.isActive === false && (
                  <div className="flex items-center gap-1.5 bg-red-100 text-red-600 text-[0.6rem] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                    <ShieldOff className="w-3 h-3" /> Заблокирована
                  </div>
                )}
                {school.subscription && (
                  <div className={`text-[0.6rem] font-black uppercase tracking-widest px-3 py-1 rounded-full ${subStatusLabel(school.subscription.status).cls}`}>
                    {subStatusLabel(school.subscription.status).label}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-4 mb-8">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black text-xl group-hover:scale-110 transition-transform ${
                  school.isActive === false ? 'bg-red-100 text-red-400' : 'bg-primary/10 text-primary'
                }`}>
                  {school.name[0]}
                </div>
                <div>
                  <h3 className="font-bold text-lg text-textPrimary group-hover:text-primary transition-colors">{school.name}</h3>
                  <p className="text-xs text-textSecondary font-medium flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> {school.city}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4 mt-auto">
                <div className="bg-surfaceLow/50 p-4 rounded-2xl text-center">
                  <p className="font-black text-textPrimary text-lg">{school.stats.students}</p>
                  <p className="text-[0.55rem] text-textSecondary uppercase tracking-widest font-black opacity-60">Студ.</p>
                </div>
                <div className="bg-surfaceLow/50 p-4 rounded-2xl text-center">
                  <p className="font-black text-textPrimary text-lg">{school.stats.teachers}</p>
                  <p className="text-[0.55rem] text-textSecondary uppercase tracking-widest font-black opacity-60">Учит.</p>
                </div>
                <div className="bg-surfaceLow/50 p-4 rounded-2xl text-center">
                  <p className="font-black text-textPrimary text-lg">{school.stats.activeBlocks}</p>
                  <p className="text-[0.55rem] text-textSecondary uppercase tracking-widest font-black opacity-60">Групп</p>
                </div>
              </div>
            </div>
          ))}

          {filteredSchools.length === 0 && (
            <div className="col-span-full py-20 text-center bg-surfaceLow/20 rounded-[3rem] border-2 border-dashed border-border/10">
              <Building2 className="w-12 h-12 text-textSecondary/20 mx-auto mb-4" />
              <p className="text-textSecondary font-medium">Школы по вашему запросу не найдены</p>
            </div>
          )}
        </div>
      )}

      {/* Sliding Detail Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-[500px] max-w-full bg-background shadow-2xl z-50 transform transition-transform duration-500 ease-in-out border-l border-border/10 overflow-y-auto ${
          selectedSchool ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {selectedSchool && (
          <div className="p-8">
            {/* Header row */}
            <div className="flex items-center justify-between mb-8">
              <button
                onClick={() => { setSelectedSchool(null); setConfirmBlock(false); setExtendOpen(false); }}
                className="p-3 hover:bg-surfaceLow rounded-full transition text-textSecondary"
              >
                <X className="w-6 h-6" />
              </button>

              {/* Кнопка блокировки — в правом верхнем углу панели */}
              <button
                onClick={() => setConfirmBlock(true)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-bold transition ${
                  isBlocked
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-red-50 text-red-600 hover:bg-red-100'
                }`}
              >
                {isBlocked
                  ? <><ShieldOn className="w-4 h-4" /> Разблокировать</>
                  : <><ShieldOff className="w-4 h-4" /> Заблокировать</>
                }
              </button>
            </div>

            {/* Статус заблокирована */}
            {isBlocked && (
              <div className="mb-6 flex items-center gap-3 bg-red-50 border border-red-200/60 rounded-2xl px-4 py-3">
                <ShieldOff className="w-5 h-5 text-red-500 flex-shrink-0" />
                <p className="text-sm text-red-600 font-medium">Школа заблокирована — вход для пользователей закрыт</p>
              </div>
            )}

            {/* Подтверждение действия */}
            {confirmBlock && (
              <div className="mb-6 bg-amber-50 border border-amber-200/60 rounded-2xl p-5">
                <div className="flex items-start gap-3 mb-4">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-amber-800 mb-1">
                      {isBlocked ? 'Разблокировать школу?' : 'Заблокировать школу?'}
                    </p>
                    <p className="text-xs text-amber-700">
                      {isBlocked
                        ? 'Все пользователи школы снова смогут войти в систему.'
                        : `Все пользователи «${selectedSchool.name}» не смогут войти в систему пока школа заблокирована.`
                      }
                    </p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleToggleActive}
                    disabled={toggling}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition disabled:opacity-50 ${
                      isBlocked
                        ? 'bg-green-600 text-white hover:bg-green-700'
                        : 'bg-red-600 text-white hover:bg-red-700'
                    }`}
                  >
                    {toggling ? 'Применяю...' : (isBlocked ? 'Да, разблокировать' : 'Да, заблокировать')}
                  </button>
                  <button
                    onClick={() => setConfirmBlock(false)}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-surfaceLow text-textSecondary hover:bg-surfaceLow/80 transition"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-6 mb-12">
              <div className={`w-20 h-20 rounded-3xl flex items-center justify-center font-black text-3xl ${
                isBlocked ? 'bg-red-100 text-red-400' : 'bg-primary/10 text-primary'
              }`}>
                {selectedSchool.name[0]}
              </div>
              <div>
                <h2 className="text-3xl font-serif text-textPrimary">{selectedSchool.name}</h2>
                <div className="flex flex-col gap-2 mt-2">
                  <p className="text-sm text-textSecondary flex items-center gap-2 font-medium">
                    <MapPin className="w-4 h-4 opacity-50" /> {selectedSchool.city}
                  </p>
                  <p className="text-sm text-textSecondary flex items-center gap-2 font-medium">
                    <Mail className="w-4 h-4 opacity-50" /> {selectedSchool.email}
                  </p>
                </div>
              </div>
            </div>

            {detailLoading ? (
              <div className="flex justify-center py-20">
                <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
              </div>
            ) : schoolDetail ? (
              <div className="space-y-10 pb-20">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-surfaceLow p-6 rounded-3xl">
                    <p className="text-[0.6rem] text-textSecondary uppercase tracking-widest font-black mb-1 opacity-60">Всего студентов</p>
                    <p className="text-2xl font-black text-textPrimary">{schoolDetail.stats.students}</p>
                  </div>
                  <div className="bg-surfaceLow p-6 rounded-3xl">
                    <p className="text-[0.6rem] text-textSecondary uppercase tracking-widest font-black mb-1 opacity-60">Преподавателей</p>
                    <p className="text-2xl font-black text-textPrimary">{schoolDetail.stats.teachers}</p>
                  </div>
                </div>

                {/* Billing section */}
                <section>
                  <h4 className="text-[0.7rem] font-black uppercase tracking-[0.2em] text-textSecondary mb-4 flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-primary" /> Подписка
                  </h4>
                  {selectedSchool.subscription ? (
                    <div className="bg-surfaceLow rounded-2xl p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-textSecondary">Статус</span>
                        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${subStatusLabel(selectedSchool.subscription.status).cls}`}>
                          {subStatusLabel(selectedSchool.subscription.status).label}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-textSecondary">Тарифный план</span>
                        <span className="text-xs font-bold uppercase tracking-wider text-textPrimary">
                          {selectedSchool.subscription.plan}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-textSecondary">Триал до</span>
                        <span className="text-xs font-medium text-textPrimary">{fmtDate(selectedSchool.subscription.trialEndsAt)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-textSecondary">Оплачено до</span>
                        <span className="text-xs font-medium text-textPrimary">{fmtDate(selectedSchool.subscription.paidUntil)}</span>
                      </div>
                      {extendOpen ? (
                        <div className="pt-3 space-y-3 border-t border-border/20">
                          <div>
                            <label className="text-[0.65rem] font-bold uppercase tracking-wider text-textSecondary mb-1.5 block">Тарифный план</label>
                            <select
                              value={selectedPlan}
                              onChange={(e) => setSelectedPlan(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl border border-border bg-background text-sm font-medium outline-none focus:ring-2 focus:ring-primary/20"
                            >
                              <option value="TRIAL">TRIAL (Пробный)</option>
                              <option value="STARTER">STARTER (Стартовый)</option>
                              <option value="OPTIMA">OPTIMA (Оптимальный)</option>
                              <option value="NETWORK">NETWORK (Сетевой)</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[0.65rem] font-bold uppercase tracking-wider text-textSecondary mb-1.5 block">Количество дней</label>
                            <input
                              type="number"
                              min={1}
                              max={3650}
                              value={extendDays}
                              onChange={(e) => setExtendDays(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl border border-border bg-background text-sm font-medium outline-none focus:ring-2 focus:ring-primary/20"
                            />
                          </div>
                          <div className="flex flex-col gap-2 pt-1">
                            <div className="flex gap-2">
                              <button
                                onClick={handleExtend}
                                disabled={extending || !extendDays || parseInt(extendDays) < 1 || parseInt(extendDays) > 3650}
                                className="flex-1 py-2.5 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-50 hover:bg-primary/90 transition-colors"
                              >
                                {extending ? 'Применяю...' : 'Продлить'}
                              </button>
                              <button
                                onClick={handleMarkPaid}
                                disabled={markingPaid || !extendDays || parseInt(extendDays) < 1 || parseInt(extendDays) > 3650}
                                className="flex-1 py-2.5 rounded-xl bg-[#008060] text-white text-xs font-bold disabled:opacity-50 hover:bg-[#006e52] transition-colors"
                              >
                                {markingPaid ? 'Применяю...' : 'Отметить оплату'}
                              </button>
                            </div>
                            <button
                              onClick={() => setExtendOpen(false)}
                              className="w-full py-2.5 rounded-xl bg-surfaceLow text-xs font-bold text-textSecondary hover:bg-surfaceLow/80 transition-colors"
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="pt-2 space-y-2">
                          <button
                            onClick={() => {
                              setSelectedPlan(selectedSchool.subscription.plan || 'STARTER');
                              setExtendOpen(true);
                            }}
                            className="w-full py-2.5 rounded-xl bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition-colors"
                          >
                            + Управление подпиской (Оплата / Продление)
                          </button>
                          {selectedSchool.subscription.status !== 'BLOCKED' && (
                            <button
                              onClick={handleBlockSubscription}
                              disabled={blockingSub}
                              className="w-full py-2.5 rounded-xl border border-red-200 text-red-600 text-xs font-bold hover:bg-red-50 transition-colors"
                            >
                              {blockingSub ? 'Применяю...' : '✗ Заблокировать подписку'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-textSecondary italic">Нет данных о подписке</p>
                  )}
                </section>

                <section>
                  <h4 className="text-[0.7rem] font-black uppercase tracking-[0.2em] text-textSecondary mb-6 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-primary" /> Администраторы
                  </h4>
                  <div className="space-y-3">
                    {schoolDetail.admins.map((adm: any) => (
                      <div key={adm.id} className="bg-surfaceLowest p-4 rounded-2xl border border-border/5 flex items-center justify-between">
                        <p className="font-bold text-sm text-textPrimary">{adm.firstName} {adm.lastName}</p>
                        <span className="text-[0.6rem] font-black uppercase tracking-widest text-primary bg-primary/10 px-3 py-1 rounded-full">Admin</span>
                      </div>
                    ))}
                    {schoolDetail.admins.length === 0 && <p className="text-xs text-textSecondary italic">Нет назначенных администраторов</p>}
                  </div>
                </section>

                <section>
                  <h4 className="text-[0.7rem] font-black uppercase tracking-[0.2em] text-textSecondary mb-6 flex items-center gap-2">
                    <GraduationCap className="w-4 h-4 text-primary" /> Преподаватели
                  </h4>
                  <div className="space-y-3">
                    {schoolDetail.teachers.map((t: any) => (
                      <div key={t.id} className="bg-surfaceLowest p-4 rounded-2xl border border-border/5">
                        <p className="font-bold text-sm text-textPrimary">{t.firstName} {t.lastName}</p>
                        <p className="text-[0.6rem] text-textSecondary font-medium mt-0.5">{t.email}</p>
                      </div>
                    ))}
                    {schoolDetail.teachers.length === 0 && <p className="text-xs text-textSecondary italic">Нет преподавателей</p>}
                  </div>
                </section>

                <section>
                  <h4 className="text-[0.7rem] font-black uppercase tracking-[0.2em] text-textSecondary mb-6 flex items-center gap-2">
                    <Users className="w-4 h-4 text-primary" /> Список студентов ({schoolDetail.students.length})
                  </h4>
                  <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                    {schoolDetail.students.map((s: any) => (
                      <div key={s.id} className="bg-surfaceLowest p-4 rounded-2xl border border-border/5 flex justify-between items-center">
                        <div>
                          <p className="font-bold text-sm text-textPrimary">{s.firstName} {s.lastName}</p>
                          <p className="text-[0.6rem] text-textSecondary font-medium mt-0.5">{s.email}</p>
                        </div>
                        <span className="text-[0.65rem] font-black text-textSecondary opacity-40 uppercase tracking-widest">{s.level}</span>
                      </div>
                    ))}
                    {schoolDetail.students.length === 0 && <p className="text-xs text-textSecondary italic">Нет зарегистрированных студентов</p>}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Backdrop */}
      {selectedSchool && (
        <div
          onClick={() => { setSelectedSchool(null); setConfirmBlock(false); setExtendOpen(false); }}
          className="fixed inset-0 bg-black/20 z-40 transition-opacity"
        />
      )}
    </SuperAdminLayout>
  );
}
