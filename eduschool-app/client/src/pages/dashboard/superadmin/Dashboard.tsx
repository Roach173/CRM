import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import api from '../../../lib/api';
import SuperAdminLayout from '../../../components/layout/SuperAdminLayout';
import { useAuth } from '../../../hooks/useAuth';
import { 
  Building2, 
  Users, 
  GraduationCap, 
  Calendar, 
  ArrowRight, 
  Settings 
} from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

export default function SuperAdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<any>(null);
  const [schools, setSchools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    if (user && user.role !== 'SUPERADMIN') {
      navigate('/login');
      return;
    }

    const timer = setInterval(() => setCurrentTime(new Date()), 1000);

    Promise.all([
      api.get('/superadmin/stats'),
      api.get('/superadmin/schools')
    ]).then(([statsRes, schoolsRes]) => {
      setStats(statsRes.data.data);
      // Берём только последние 5 школ
      setSchools((schoolsRes.data.data || []).slice(0, 5));
    }).finally(() => setLoading(false));

    return () => clearInterval(timer);
  }, [user, navigate]);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
    </div>
  );

  return (
    <SuperAdminLayout>
      <div className="animate-in zoom-in-95 duration-300">
        {/* Header */}
        <div className="mb-10 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
          <div>
            <h1 className="font-serif text-2xl text-textPrimary">Панель управления</h1>
            <p className="text-textSecondary text-sm mt-0.5">
              {format(currentTime, 'EEEE, d MMMM yyyy • HH:mm:ss', { locale: ru })}
            </p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          {[
            { 
              label: 'Школы', 
              value: stats?.totalSchools, 
              icon: Building2, 
              color: 'text-primary', 
              bg: 'bg-primary/5' 
            },
            { 
              label: 'Студенты', 
              value: stats?.totalStudents, 
              icon: Users, 
              color: 'text-blue-500', 
              bg: 'bg-blue-50' 
            },
            { 
              label: 'Учителя', 
              value: stats?.totalTeachers, 
              icon: GraduationCap, 
              color: 'text-purple-500', 
              bg: 'bg-purple-50' 
            },
            { 
              label: 'Активных групп', 
              value: stats?.totalBlocks, 
              icon: Calendar, 
              color: 'text-primary',
              bg: 'bg-primaryContainer'
            },
          ].map((s, idx) => (
            <div key={idx} className="bg-surfaceLowest rounded-3xl p-6 border border-border/5 shadow-sm hover:shadow-md transition">
              <div className="flex justify-between items-start mb-4">
                <div className={`p-3 rounded-2xl ${s.bg} ${s.color}`}>
                  <s.icon className="w-6 h-6" />
                </div>
                <span className="text-[10px] font-black text-textSecondary/40 uppercase tracking-widest">— развитие</span>
              </div>
              <p className={`text-4xl font-black ${s.color} tracking-tight`}>{s.value}</p>
              <p className="text-[10px] text-textSecondary uppercase tracking-widest font-black mt-2 opacity-60">{s.label}</p>
              <p className="text-[9px] text-textSecondary/40 font-bold mt-1 tracking-wider">+ — за последний месяц</p>
            </div>
          ))}
        </div>

        {/* Recent Registrations Table */}
        <div className="bg-surfaceLowest rounded-3xl border border-border/5 shadow-sm overflow-hidden mb-10">
          <div className="p-8 border-b border-border/5">
            <h2 className="text-xl font-serif text-textPrimary">Последние регистрации</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="responsive-table w-full text-left">
              <thead>
                <tr className="bg-surfaceLow/10">
                  <th className="px-8 py-4 text-[10px] font-black text-textSecondary uppercase tracking-widest">Школа</th>
                  <th className="px-8 py-4 text-[10px] font-black text-textSecondary uppercase tracking-widest">Город</th>
                  <th className="px-8 py-4 text-[10px] font-black text-textSecondary uppercase tracking-widest text-center">Студентов</th>
                  <th className="px-8 py-4 text-[10px] font-black text-textSecondary uppercase tracking-widest text-center">Учителей</th>
                  <th className="px-8 py-4 text-[10px] font-black text-textSecondary uppercase tracking-widest text-center">Групп</th>
                  <th className="px-8 py-4 text-[10px] font-black text-textSecondary uppercase tracking-widest text-right">Дата</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/5">
                {schools.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-8 py-10 text-center text-textSecondary text-sm font-medium italic">Данные отсутствуют</td>
                  </tr>
                )}
                {schools.map(school => (
                  <tr 
                    key={school.id} 
                    onClick={() => navigate('/superadmin/schools')}
                    className="hover:bg-surfaceLow/30 transition cursor-pointer group"
                  >
                    <td data-label="Школа" className="px-8 py-5">
                      <div className="min-w-0">
                        <p className="font-bold text-textPrimary group-hover:text-primary transition-colors truncate">{school.name}</p>
                        <p className="text-[10px] text-textSecondary opacity-60 truncate">{school.email}</p>
                      </div>
                    </td>
                    <td data-label="Город" className="px-8 py-5 text-sm text-textSecondary font-medium">{school.city}</td>
                    <td data-label="Студентов" className="px-8 py-5 text-center font-black text-textPrimary">{school.stats.students}</td>
                    <td data-label="Учителей" className="px-8 py-5 text-center font-black text-textPrimary">{school.stats.teachers}</td>
                    <td data-label="Групп" className="px-8 py-5 text-center font-black text-textPrimary">{school.stats.activeBlocks}</td>
                    <td data-label="Дата" className="px-8 py-5 text-right text-[11px] font-bold text-textSecondary/60">
                      {format(new Date(school.createdAt), 'dd MMM yyyy', { locale: ru })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex flex-wrap gap-4">
          <button 
            onClick={() => navigate('/superadmin/schools')}
            className="flex items-center gap-3 bg-primary text-white px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:brightness-110 shadow-xl shadow-primary/20 transition active:scale-95"
          >
            Все школы
            <ArrowRight className="w-4 h-4" />
          </button>
          <button 
            onClick={() => navigate('/superadmin/settings')}
            className="flex items-center gap-3 bg-surfaceLow text-textPrimary px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-surfaceLowest transition active:scale-95 border border-border/5"
          >
            <Settings className="w-4 h-4" />
            Настройки
          </button>
        </div>
      </div>
    </SuperAdminLayout>
  );
}
