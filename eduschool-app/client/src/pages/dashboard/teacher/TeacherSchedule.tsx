import React, { useState, useEffect, useMemo } from 'react';
import { useSchedule, addWeeks, weekKey, weekLabel } from '../../../hooks/useSchedule';
import api from '../../../lib/api';
import type { SchedView } from '../../../components/schedule/scheduleTypes';
import WeekGrid from '../../../components/schedule/WeekGrid';
import RoomsView from '../../../components/schedule/RoomsView';
import MonthView from '../../../components/schedule/MonthView';
// Lazy: SlotPanel (~54KB gzip) only renders after a cell click — a static
// import made it block the page's first paint.
const SlotPanel = React.lazy(() => import('../../../components/schedule/SlotPanel'));
import { Clock, UserCheck, Calendar as CalendarIcon, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';

const MN = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

// Owner-parity toolbar button (matches admin Schedule's inactiveBtn).
const navBtn = 'px-3 py-1.5 text-sm font-medium border border-border rounded bg-white dark:bg-card text-textPrimary hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-colors cursor-pointer select-none outline-none focus:outline-none';

export default function TeacherSchedule() {
  const sched = useSchedule();
  const [loading, setLoading] = useState(true);

  // Seed from teacher-scoped endpoint — only this teacher's groups.
  // Also fetch the school's current timeslots so loadFromServer can tell which
  // slots are really in the grid — without them every slot is flagged "вне сетки".
  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/schedule/teacher'),
      api.get('/settings/timeslots'),
    ])
      .then(([blocksRes, slotsRes]) => {
        const blocks = blocksRes.data?.data ?? [];
        const policy = slotsRes.data?.data ?? {};
        const dbSlots = Array.isArray(policy.slots) && policy.slots.length > 0
          ? (policy.slots as Array<{ id: number; startTime: string; endTime: string }>).map(sl => ({
              id: sl.id, s: sl.startTime, e: sl.endTime,
            }))
          : undefined;
        if (Array.isArray(blocks)) {
          sched.loadFromServer(blocks, dbSlots, policy.activeDays);
        }
      })
      .catch(() => { /* intentional — mount fetch */ })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  // View state
  const [view, setView] = useState<SchedView>('week');
  const [viewWk, setViewWk] = useState(() => weekKey(new Date()));
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // Overlay state
  const [slotPanel, setSlotPanel] = useState<{ ci: number; sid: number; gid?: number; fromRooms?: boolean; roomName?: string } | null>(null);

  // Computed data for "Today" section
  const todaySessions = useMemo(() => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    return Object.values(sched.G).flatMap(b => {
      const session = (b as any).sessions?.find((s: any) => 
        s.date?.slice(0, 10) === todayStr
      );
      return session ? [{ block: b, session }] : [];
    });
  }, [sched.G]);

  if (loading && Object.keys(sched.G).length === 0) {
    return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:16 }}>
        <Loader2 className="animate-spin" size={40} color="rgb(var(--color-primary))" />
        <span style={{ color:'rgb(var(--color-text-secondary))', fontWeight:500 }}>Загрузка вашего расписания...</span>
      </div>
    );
  }

  return (
    <div className="pb-20 lg:pb-0">

      {/* ── Today's Sessions (Premium Highlight) ─────────────────────────────── */}
      {todaySessions.length > 0 && view === 'week' && (
        <div style={{ marginBottom:32 }} className="animate-in slide-in-from-top-4 duration-700">
           <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16, paddingLeft:4 }}>
             <div style={{ width:8, height:8, borderRadius:'50%', background:'rgb(var(--color-primary))', boxShadow:'0 0 10px rgb(var(--color-primary))' }} className="animate-pulse" />
             <h2 style={{ fontSize:12, fontWeight:900, textTransform:'uppercase', letterSpacing:'0.1em', color:'rgb(var(--color-text-secondary))', margin:0 }}>
               Занятия на сегодня
             </h2>
           </div>
           <div style={{ display:'flex', gap:16, overflowX:'auto', paddingBottom:12, scrollbarWidth:'none' }}>
              {todaySessions.map(({ block, session }) => (
                <div 
                  key={session.id} 
                  style={{ 
                    minWidth:320, 
                    background:'rgb(var(--color-surface-lowest))', 
                    borderRadius:24, 
                    padding:24, 
                    border:'1px solid rgb(var(--color-border))',
                    boxShadow:'0 10px 30px -10px rgba(0,0,0,0.05)',
                    display:'flex',
                    flexDirection:'column',
                    justifyContent:'space-between',
                    position:'relative',
                    overflow:'hidden'
                  }}
                  className="group hover:border-primary/30 transition"
                >
                   <div style={{ position:'absolute', top:0, left:0, width:4, height:'100%', background:'rgb(var(--color-primary))' }} />
                   <div>
                     <div style={{ display:'flex', justifyContent:'space-between', alignItems:'start', marginBottom:12 }}>
                        <span style={{ fontSize:18, fontWeight:800, color:'rgb(var(--color-primary))' }}>{block.lv}</span>
                        <span style={{ 
                          padding:'4px 10px', 
                          borderRadius:8, 
                          fontSize:10, 
                          fontWeight:900, 
                          textTransform:'uppercase',
                          background: session.status === 'CANCELLED' ? 'rgb(var(--color-danger))15' : 'rgb(var(--color-primary))10',
                          color: session.status === 'CANCELLED' ? 'rgb(var(--color-danger))' : 'rgb(var(--color-primary))'
                        }}>
                           {session.status === 'CANCELLED' ? 'Отменен' : (block.n || '—')}
                        </span>
                     </div>
                     <div style={{ display:'flex', alignItems:'center', gap:8, color:'rgb(var(--color-text-secondary))', marginBottom:20 }}>
                        <Clock size={14} />
                        <span style={{ fontSize:14, fontWeight:600 }}>{block.startTime || '—'} – {block.endTime || '—'}</span>
                     </div>
                   </div>
                   
                   {session.status === 'CANCELLED' ? (
                     <div style={{ 
                       padding:'12px', 
                       textAlign:'center', 
                       fontSize:11, 
                       fontWeight:800, 
                       textTransform:'uppercase', 
                       color:'rgb(var(--color-danger))', 
                       background:'rgb(var(--color-danger))05',
                       borderRadius:12,
                       border:'1px dashed rgb(var(--color-danger))30'
                     }}>
                       Урок отменён
                     </div>
                   ) : (
                     <button 
                       onClick={() => {
                         const cellIndex = Object.values(sched.G).indexOf(block);
                         setSlotPanel({ ci: cellIndex, sid: session.id });
                       }}
                       style={{ 
                         width:'100%', 
                         padding:'12px', 
                         background:'rgb(var(--color-primary))', 
                         color:'#fff', 
                         borderRadius:12, 
                         border:'none',
                         fontSize:12, 
                         fontWeight:800, 
                         textTransform:'uppercase', 
                         cursor:'pointer',
                         display:'flex',
                         alignItems:'center',
                         justifyContent:'center',
                         gap:8,
                         boxShadow:'0 4px 12px rgb(var(--color-primary))30'
                       }}
                     >
                       <UserCheck size={16} /> Журнал посещаемости
                     </button>
                   )}
                </div>
              ))}
           </div>
        </div>
      )}

      {/* ── Toolbar — mirrors owner: zoom (left) · week/month navigator (centered) · view switch (right) ── */}
      <div className="mb-3.5">
        <div className="relative flex flex-wrap items-center gap-2">
          {/* Zoom (desktop, week/rooms only) */}
          {view !== 'month' && (
            <div className="hidden lg:flex items-center border border-border rounded bg-white dark:bg-card overflow-hidden">
              <button onClick={() => sched.changeZoom(-10)} className="px-2.5 py-1.5 text-sm text-textPrimary hover:bg-surface transition-colors cursor-pointer border-r border-border">−</button>
              <span className="px-2 text-sm text-textSecondary min-w-[44px] text-center select-none">{sched.zoom}%</span>
              <button onClick={() => sched.changeZoom(10)} className="px-2.5 py-1.5 text-sm text-textPrimary hover:bg-surface transition-colors cursor-pointer border-l border-border">+</button>
            </div>
          )}

          <div className="flex-1" />

          {/* Week / month navigator — absolutely centered on desktop so side controls never shift it.
              Same pill + separate «Сегодня» button as the student schedule page. */}
          <div className="lg:absolute lg:left-1/2 lg:top-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2 flex items-center gap-2">
            <div className="flex items-center gap-1 bg-surfaceLow rounded-2xl p-1">
              <button
                type="button"
                className="p-2 hover:bg-white rounded-xl text-textSecondary transition"
                onClick={() =>
                  view === 'month'
                    ? setViewMonth(p => { const d = new Date(p.year, p.month - 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })
                    : setViewWk(addWeeks(viewWk, -1))
                }
              ><ChevronLeft className="w-4 h-4" /></button>
              <div className="min-w-[150px] px-2 py-1.5 text-center text-sm font-semibold text-textPrimary">
                {view === 'month' ? `${MN[viewMonth.month]} ${viewMonth.year}` : weekLabel(viewWk)}
              </div>
              <button
                type="button"
                className="p-2 hover:bg-white rounded-xl text-textSecondary transition"
                onClick={() =>
                  view === 'month'
                    ? setViewMonth(p => { const d = new Date(p.year, p.month + 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })
                    : setViewWk(addWeeks(viewWk, 1))
                }
              ><ChevronRight className="w-4 h-4" /></button>
            </div>
            <button
              type="button"
              onClick={() => {
                const d = new Date();
                setViewWk(weekKey(d));
                setViewMonth({ year: d.getFullYear(), month: d.getMonth() });
              }}
              className="px-4 py-2 bg-surfaceLow hover:bg-primaryContainer/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-primary transition"
            >
              Сегодня
            </button>
          </div>

          <div className="flex-1" />

          {/* View switch (right) */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {loading && <span className="text-xs text-textSecondary">Загрузка...</span>}
            {(['week', 'month', 'rooms'] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={view === v
                  ? 'px-3 py-1.5 text-sm font-medium border border-primary rounded bg-primary text-white transition-colors cursor-pointer select-none'
                  : navBtn}
              >
                {v === 'week' ? 'Неделя' : v === 'month' ? 'Месяц' : 'Кабинеты'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Render Active View ─────────────────────────────────────────────── */}
      {view === 'week' && (
        <WeekGrid
          sched={sched}
          viewWk={viewWk}
          zoom={sched.zoom}
          isTeacher
          onCellClick={(ci, sid, _room, gid) => setSlotPanel({ ci, sid, gid })}
          onDayAnnotation={() => {}}
        />
      )}

      {view === 'month' && (
        <MonthView
          sched={sched}
          month={viewMonth}
          onDayClick={dk => {
            const d = new Date(dk + 'T00:00:00');
            setViewWk(weekKey(d));
            setView('week');
          }}
        />
      )}

      {view === 'rooms' && (
        <RoomsView
          sched={sched}
          viewWk={viewWk}
          teacherFilter=""
          zoom={sched.zoom}
          isTeacher
          onCellClick={(ci, sid, room, gid) => setSlotPanel({ ci, sid, gid, fromRooms: true, roomName: room })}
        />
      )}

      {/* ── SlotPanel (Attendance / Details) ─────────────────────────────────── */}
      {slotPanel && (
        <React.Suspense fallback={null}>
        <SlotPanel
          sched={sched}
          ci={slotPanel.ci}
          sid={slotPanel.sid}
          onClose={() => setSlotPanel(null)}
          selectedGid={slotPanel.gid}
          showSlotAsLabel={slotPanel.fromRooms}
          roomName={slotPanel.roomName}
          viewWk={viewWk}
          readOnly={false}
          isTeacher={true}
        />
        </React.Suspense>
      )}

      {/* Empty State if no blocks */}
      {!loading && Object.keys(sched.G).length === 0 && (
        <div style={{ 
          display:'flex', 
          flexDirection:'column', 
          alignItems:'center', 
          justifyContent:'center', 
          padding:'64px 0', 
          textAlign:'center' 
        }}>
          <div style={{ 
            width:80, 
            height:80, 
            borderRadius:32, 
            background:'rgb(var(--color-surface-low))', 
            display:'flex', 
            alignItems:'center', 
            justifyContent:'center', 
            marginBottom:20,
            border:'1px solid rgb(var(--color-border))'
          }}>
            <CalendarIcon size={32} color="rgb(var(--color-text-secondary))" />
          </div>
          <h3 style={{ fontSize:20, fontWeight:800, color:'rgb(var(--color-text-primary))', margin:'0 0 8px 0' }}>У вас пока нет занятий</h3>
          <p style={{ color:'rgb(var(--color-text-secondary))', maxWidth:300, fontSize:14 }}>Ваше расписание появится здесь, как только администратор назначит вам уроки.</p>
        </div>
      )}
    </div>
  );
}
