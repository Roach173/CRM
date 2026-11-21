import sys

file_path = r'c:\Users\Slim 7 Aura\Desktop\сайт для школы\eduschool-app\client\src\pages\dashboard\admin\Schedule.tsx'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add renderMonthGrid before return
render_month_grid = """
  const renderMonthGrid = () => {
    const monthStart = startOfMonth(currentWeekStart);
    const monthEnd = endOfMonth(currentWeekStart);
    const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
    const endDate = addDays(startOfWeek(monthEnd, { weekStartsOn: 1 }), 6);
    
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    
    return (
      <div className="bg-surfaceLow rounded-[2.5rem] p-6 shadow-inner border border-border/5 mb-8 overflow-x-auto min-w-[800px]">
        <div className="flex items-center justify-between mb-4 px-4">
          <div className="flex bg-surfaceLowest p-1 rounded-2xl border border-border/5 items-center">
            <button onClick={handlePrev} className="p-2 hover:bg-surfaceLow rounded-xl text-textSecondary transition-all">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="px-4 text-center min-w-[200px]">
              <span className="text-xs font-black uppercase tracking-widest text-textPrimary">{dateRangeText}</span>
            </div>
            <button onClick={handleNext} className="p-2 hover:bg-surfaceLow rounded-xl text-textSecondary transition-all">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <button onClick={handleToday} className="px-4 py-2 hover:bg-surfaceLowest bg-white border border-border/5 rounded-xl text-[10px] font-black uppercase tracking-widest text-primary transition-all">
            Сегодня
          </button>
        </div>
        <div className="grid grid-cols-7 gap-px bg-border/5 rounded-2xl overflow-hidden border border-border/5">
          {DAYS.map(d => (
            <div key={d} className="bg-surfaceLowest p-3 text-center text-[10px] font-black uppercase text-textSecondary">{d}</div>
          ))}
          {days.map((day) => {
            const dateStr = format(day, 'yyyy-MM-dd');
            const isCurrentMonth = isSameMonth(day, monthStart);
            
            const daySessionsCount = lessons.reduce((count, l) => {
               const hasSession = l.sessions?.some((s: any) => format(new Date(s.date), 'yyyy-MM-dd') === dateStr);
               if (!hasSession && (!l.sessions || l.sessions.length === 0)) {
                  if (l.days.includes(DAYS[(day.getDay() + 6) % 7])) {
                     const cellTime = day.getTime();
                     const startT = new Date(l.startDate).setHours(0,0,0,0);
                     const endT = l.endDate ? new Date(l.endDate).setHours(23,59,59,999) : Infinity;
                     if (cellTime >= startT && cellTime <= endT) return count + 1;
                  }
               }
               return hasSession ? count + 1 : count;
            }, 0);

            return (
              <div key={dateStr} className={`min-h-[100px] p-3 border-t border-l border-border/5 ${isCurrentMonth ? 'bg-surfaceLowest' : 'bg-surfaceLow/30'} flex flex-col hover:bg-surfaceLow/50 transition-colors`}>
                <div className={`text-xs font-bold w-7 h-7 flex items-center justify-center rounded-full mb-2 ${isToday(day) ? 'bg-primary text-white shadow-md' : 'text-textSecondary/50'}`}>
                  {format(day, 'd')}
                </div>
                {daySessionsCount > 0 && (
                  <div className="mt-auto px-2 py-1.5 bg-primary/10 text-primary rounded-lg text-[10px] font-bold text-center border border-primary/10">
                    {daySessionsCount} групп{daySessionsCount > 1 ? (daySessionsCount < 5 ? 'ы' : 'п') : 'а'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return ("""

content = content.replace('  return (', render_month_grid)

# 2. Main Grid view conditionally
main_grid_old = """      {/* Main Grid */}
      <div className="bg-surfaceLow rounded-[2.5rem] p-6 overflow-x-auto shadow-inner border border-border/5 mb-8">"""

main_grid_new = """      {/* Main Grid */}
      {view === 'week' ? (
      <div className="bg-surfaceLow rounded-[2.5rem] p-6 overflow-x-auto shadow-inner border border-border/5 mb-8">"""

content = content.replace(main_grid_old, main_grid_new)

# 3. Close the week grid wrap
week_close_old = """        </div>
      </div>

      {/* Add Students Modal */}"""

week_close_new = """        </div>
      </div>
      ) : renderMonthGrid()}

      {/* Add Students Modal */}"""

content = content.replace(week_close_old, week_close_new)

# 4. Add managing session logic inside the map
day_map_old = """                  return (
                    <div key={day} className="px-1 space-y-2">
                      {dayLessons.map(l => (
                        <div key={l.id} className="bg-surfaceLowest p-3 rounded-2xl border-l-4 border-primary shadow-sm group relative">
                          <button """

day_map_new = """                  return (
                    <div key={day} className="px-1 space-y-2">
                      {dayLessons.map(l => {
                        const currentSession = l.sessions?.find((s: any) => format(new Date(s.date), 'yyyy-MM-dd') === cellDateStr);
                        const isCancelled = currentSession?.status === 'CANCELLED';
                        return (
                        <div key={l.id} className={`bg-surfaceLowest p-3 rounded-2xl border-l-4 ${isCancelled ? 'border-danger/50 opacity-60' : 'border-primary'} shadow-sm group relative`}>
                          <button """

content = content.replace(day_map_old, day_map_new)

menu_old = """                          {activeMenuId === l.id && (
                            <div className="absolute right-1 top-7 bg-surfaceLowest border border-border/10 shadow-2xl rounded-xl p-1 z-20 min-w-[120px] animate-in fade-in zoom-in-95 duration-200">
                              <button 
                                onClick={() => handleEditClick(l)}"""

menu_new = """                          {activeMenuId === l.id && (
                            <div className="absolute right-1 top-7 bg-surfaceLowest border border-border/10 shadow-2xl rounded-xl p-1 z-20 min-w-[120px] animate-in fade-in zoom-in-95 duration-200">
                              <div className="px-3 py-1.5 text-[8px] font-black uppercase text-textSecondary/40 border-b border-border/5 mb-1 tracking-widest">
                                Группа в целом
                              </div>
                              <button 
                                onClick={() => handleEditClick(l)}"""

content = content.replace(menu_old, menu_new)

delete_old = """                                <Trash2 className="w-3 h-3" /> Удалить
                              </button>
                            </div>
                          )}"""

delete_new = """                                <Trash2 className="w-3 h-3" /> Удалить
                              </button>
                              
                              {currentSession && (
                                <>
                                  <div className="px-3 py-1.5 text-[8px] font-black uppercase text-textSecondary/40 border-b border-t border-border/5 my-1 tracking-widest">
                                    Этот урок ({format(new Date(cellDateStr), 'dd.MM')})
                                  </div>
                                  <button 
                                    onClick={() => { setManagingSession({ session: currentSession, block: l }); setActiveMenuId(null); }}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-bold text-primary hover:bg-primary/5 rounded-lg transition-all"
                                  >
                                    <Edit2 className="w-3 h-3" /> Управление уроком
                                  </button>
                                </>
                              )}
                            </div>
                          )}"""

content = content.replace(delete_old, delete_new)

# 5. Visual changes to Actual teacher
teacher_old = """                             <div className="flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-sm" />
                                <span className="text-[10px] font-bold text-textPrimary leading-none">
                                  {l.grammarTeacher?.firstName} {l.grammarTeacher?.lastName[0]}.
                                </span>
                             </div>"""

teacher_new = """                             <div className="flex items-center gap-1.5">
                                <span className={`w-1.5 h-1.5 rounded-full ${currentSession?.actualTeacher ? 'bg-orange-500' : 'bg-blue-500'} shadow-sm`} />
                                <span className="text-[10px] font-bold text-textPrimary leading-none">
                                  {currentSession?.actualTeacher 
                                    ? `${currentSession.actualTeacher.firstName} ${currentSession.actualTeacher.lastName[0]}. (Замена)`
                                    : (l.grammarTeacher ? `${l.grammarTeacher.firstName} ${l.grammarTeacher.lastName[0]}.` : 'Без учителя')
                                  }
                                </span>
                             </div>"""

content = content.replace(teacher_old, teacher_new)

students_old = """                            <span className="text-[8px] font-black text-primary">{l._count?.students}/{l.maxStudents}</span>
                          </div>
                        </div>
                      ))}"""

students_new = """                            <span className={`text-[8px] font-black ${l._count?.students >= l.maxStudents ? 'text-danger' : 'text-primary'}`}>{l._count?.students}/{l.maxStudents}</span>
                          </div>
                          
                          {/* Progress bar */}
                          <div className="h-1 w-full bg-border/20 rounded-full mt-2 overflow-hidden">
                            <div 
                              className={`h-full ${l._count?.students >= l.maxStudents ? 'bg-danger/50' : 'bg-primary/50'}`} 
                              style={{ width: `${Math.min(100, (l._count?.students || 0) / l.maxStudents * 100)}%` }} 
                            />
                          </div>

                          {isCancelled && (
                            <div className="absolute inset-0 bg-surfaceLowest/80 backdrop-blur-[1px] flex items-center justify-center rounded-2xl z-0 pointer-events-none">
                              <span className="text-danger font-black text-xs uppercase tracking-widest border border-danger/20 bg-danger/5 px-2 py-1 rounded shadow-sm rotate-[-10deg]">Отменен</span>
                            </div>
                          )}
                        </div>
                      );
                      })}"""

content = content.replace(students_old, students_new)

# 6. ManagingSession Modal
modal_insertion = """

      {/* Edit Modal */}"""

modal_new = """

      {/* Managing Session Modal */}
      {managingSession && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-surfaceLowest w-full max-w-xl rounded-[3rem] p-10 shadow-2xl border border-border/5 animate-in zoom-in-95 duration-300">
            <div className="flex justify-between items-center mb-8">
              <div>
                <h2 className="text-3xl font-serif text-textPrimary">Управление уроком</h2>
                <p className="text-sm text-textSecondary mt-1">
                  Настройки для занятия {format(new Date(managingSession.session.date), 'dd MMMM yyyy (EEEE)', { locale: ru })} <br/>
                  <span className="font-bold text-primary">{managingSession.block.level}</span>
                </p>
              </div>
              <button onClick={() => setManagingSession(null)} className="p-3 hover:bg-surfaceLow rounded-2xl transition-all text-textSecondary">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="space-y-6">
              <div>
                <label className="text-[10px] font-black text-textSecondary uppercase tracking-widest block mb-1.5 pl-1">Замена преподавателя на 1 день</label>
                <div className="flex items-center gap-2">
                  <select 
                    value={managingSession.session.actualTeacherId || ''} 
                    onChange={async (e) => {
                      const newTeacherId = e.target.value;
                      // Optimistic Update
                      setManagingSession((prev: any) => ({
                         ...prev,
                         session: { ...prev.session, actualTeacherId: newTeacherId ? Number(newTeacherId) : null }
                      }));
                      try {
                        await api.patch(`/lessons/session/${managingSession.session.id}/teacher`, { teacherId: newTeacherId });
                        toast.success('Замена установлена');
                        fetchData();
                      } catch(err) { toast.error('Ошибка замены'); }
                    }}
                    className="w-full bg-surfaceLow border-none rounded-2xl py-4 px-5 text-sm font-bold focus:ring-2 focus:ring-primary shadow-sm"
                  >
                    <option value="">(Основной преподаватель: {managingSession.block.grammarTeacher?.firstName})</option>
                    {teachers.map((t: any) => <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-black text-textSecondary uppercase tracking-widest block mb-1.5 pl-1">Статус проведения</label>
                <div className="flex gap-2">
                  <button 
                    onClick={async () => {
                      const newStatus = managingSession.session.status === 'CANCELLED' ? 'UPCOMING' : 'CANCELLED';
                      setManagingSession((prev: any) => ({
                         ...prev,
                         session: { ...prev.session, status: newStatus }
                      }));
                      try {
                        await api.patch(`/lessons/session/${managingSession.session.id}/status`, { status: newStatus });
                        toast.success('Статус обновлен');
                        fetchData();
                      } catch(err) { toast.error('Ошибка'); }
                    }}
                    className={`flex-1 rounded-2xl py-4 flex items-center justify-center gap-2 text-xs font-bold transition-all ${managingSession.session.status === 'CANCELLED' ? 'bg-danger/10 text-danger border border-danger/20' : 'bg-surfaceLow text-textSecondary hover:bg-surfaceLow/70'}`}
                  >
                    <ShieldAlert className="w-4 h-4" />
                    {managingSession.session.status === 'CANCELLED' ? 'Урок отменен (Вернуть)' : 'Отменить этот урок'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}"""

content = content.replace(modal_insertion, modal_new)

# 7. Remove unused import List
content = content.replace('PlusCircle, Calendar, List, Loader2,', 'PlusCircle, Calendar, Loader2,')

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Patch applied to Schedule.tsx")
