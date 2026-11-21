import { useState } from 'react';
import { useSalaryApi, type StaffSalary } from '../../../hooks/useSalaryApi';
import { useNavigate } from 'react-router';
import { Download, FileText } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Spinner } from '../../../components/ui/Spinner';
import { EmptyState } from '../../../components/ui/EmptyState';
import SearchInput from '../../../components/ui/SearchInput';
import { MonthYearPicker, currentPeriod } from '../../../components/ui/MonthYearPicker';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string { return Math.round(n).toLocaleString('ru-RU'); }

function initials(name: string): string {
  return name.split(' ').map(p => p[0] ?? '').join('').toUpperCase().slice(0, 2);
}

// ─── StaffCard ────────────────────────────────────────────────────────────────

function StaffCard({ staff, onNavigateToPayslip }: {
  staff: StaffSalary;
  onNavigateToPayslip: (staffId: number) => void;
}) {
  return (
    <button
      onClick={() => onNavigateToPayslip(staff.userId)}
      className="bg-surfaceLowest rounded-2xl border border-border overflow-hidden hover:border-primary/40 hover:bg-surfaceLow/40 transition text-left"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <span className="text-primary font-bold text-xs">{initials(staff.name)}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-textPrimary truncate">{staff.name}</p>
          <p className="text-xs text-textSecondary">{staff.unpaidLessonsCount} ур. · {fmt(staff.remainingAmount)} сом</p>
        </div>
        <Badge variant={staff.isPaid ? 'success' : staff.remainingAmount > 0 ? 'danger' : 'neutral'}>
          {staff.isPaid ? 'Выплачено' : staff.remainingAmount > 0 ? 'Ожидает' : '—'}
        </Badge>
      </div>
    </button>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function Salary() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(currentPeriod);

  const {
    data: staffSalaries,
    loading,
  } = useSalaryApi(period);


  const [search, setSearch] = useState('');

  const handleNavigateToPayslip = (staffId: number) => {
    navigate(`./${staffId}`);
  };

  if (loading && staffSalaries.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-background">
        <Spinner size="lg" />
        <p className="text-textSecondary mt-4 animate-pulse">Загрузка данных по зарплатам...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Header — search + actions in one row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
        <SearchInput value={search} onChange={setSearch} className="flex-1" />
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <MonthYearPicker value={period} onChange={setPeriod} />
          <Button variant="outline" size="sm">
            <Download className="w-4 h-4" /> Экспорт
          </Button>
        </div>
      </div>

      {(() => {
        const filtered = staffSalaries.filter(s =>
          s.name.toLowerCase().includes(search.toLowerCase())
        );
        if (staffSalaries.length === 0) return (
          <EmptyState
            title="Данные не найдены"
            description="В выбранном периоде пока нет данных по зарплатам"
            icon={<FileText size={40} />}
          />
        );
        if (filtered.length === 0) return (
          <EmptyState
            title="Ничего не найдено"
            description="Попробуйте изменить запрос"
            icon={<FileText size={40} />}
          />
        );
        return (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {filtered.map(s => (
              <StaffCard
                key={s.userId}
                staff={s}
                onNavigateToPayslip={handleNavigateToPayslip}
              />
            ))}
          </div>
        );
      })()}

    </div>
  );
}
