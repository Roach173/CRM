import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import api from '../../lib/api';
import { MonthYearPicker, currentPeriod } from './MonthYearPicker';

// Месячная выписка-выверка по журналу кредитов (roll-forward):
// было + пополнения − списания = стало. Расхождение баланса с журналом
// показываем явно (foots=false) — никогда не маскируем.

interface StatementLine {
  id: number;
  date: string;
  amount: number;
  reason: string;
  type: string;
  sessionDate: string | null;
  actorName: string | null;
}

interface Statement {
  month: string;
  opening: number;
  added: number;
  deducted: number;
  closing: number;
  ledgerBalance: number;
  profileBalance: number;
  foots: boolean;
  lines: StatementLine[];
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Without studentProfileId the component is self-service: it hits /my-statement,
// which resolves the profile from the JWT (student's own view).
export function CreditStatement({ studentProfileId }: { studentProfileId?: number }) {
  const selfService = studentProfileId == null;
  const [month, setMonth]         = useState(currentPeriod);
  const [opened, setOpened]       = useState(false);
  const [loading, setLoading]     = useState(false);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [error, setError]         = useState(false);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(false);
    try {
      const url = selfService ? '/credits/my-statement' : `/credits/statement/${studentProfileId}`;
      const res = await api.get(url, { params: { month: m } });
      setStatement(res.data.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [studentProfileId, selfService]);

  // Fetch lazily on first expand, then on month change.
  useEffect(() => {
    if (opened) void load(month);
  }, [opened, month, load]);

  return (
    <details onToggle={e => setOpened((e.target as HTMLDetailsElement).open)}>
      <summary className="text-[10px] font-bold uppercase tracking-widest text-textSecondary cursor-pointer select-none list-none flex items-center gap-1.5">
        <span>{opened ? '▾' : '▸'}</span>
        {selfService ? 'Списания и пополнения кредитов' : 'Выписка по урокам'}
      </summary>
      {!opened && selfService && (
        <p className="text-xs text-textSecondary/70 mt-1">
          Здесь видно, за какие уроки списывались кредиты и когда баланс пополнялся
        </p>
      )}

      <div className="mt-3 p-4 bg-surfaceLow rounded-xl border border-border/30 space-y-3">
        <MonthYearPicker value={month} onChange={setMonth} />

        {loading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-textSecondary" /></div>
        ) : error ? (
          <p className="text-sm text-danger text-center py-2">Не удалось загрузить выписку</p>
        ) : statement && (
          <>
            {/* Roll-forward: opening → lines → closing */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-textSecondary">Было на начало месяца</span>
              <span className="font-bold">{statement.opening}</span>
            </div>

            {statement.lines.length === 0 ? (
              <p className="text-xs text-textSecondary/60 text-center py-1">Движений за месяц нет</p>
            ) : (
              <div className="space-y-1 border-y border-border/30 py-2">
                {statement.lines.map(l => (
                  <div key={l.id} className="flex items-baseline gap-2 text-xs">
                    <span className="text-textSecondary shrink-0 font-mono">{fmtDay(l.sessionDate ?? l.date)}</span>
                    <span className="text-textPrimary truncate flex-1" title={l.actorName ? `${l.reason} — ${l.actorName}` : l.reason}>
                      {l.reason}
                    </span>
                    <span className={`font-bold shrink-0 ${l.amount > 0 ? 'text-success' : 'text-danger'}`}>
                      {l.amount > 0 ? `+${l.amount}` : l.amount}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between text-sm">
              <span className="text-textSecondary">
                Стало на конец месяца
                {statement.added !== 0 && <span className="text-success"> +{statement.added}</span>}
                {statement.deducted !== 0 && <span className="text-danger"> −{Math.abs(statement.deducted)}</span>}
              </span>
              <span className="font-bold">{statement.closing}</span>
            </div>

            {/* Foot check: surface the gap, never plug it */}
            {!statement.foots && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-danger/5 border border-danger/30">
                <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <p className="text-xs text-danger">
                  {selfService
                    ? `Баланс (${statement.profileBalance}) не сходится с журналом (${statement.ledgerBalance}). Обратитесь в администрацию школы.`
                    : `Баланс студента (${statement.profileBalance}) не сходится с журналом (${statement.ledgerBalance}). Разница: ${statement.profileBalance - statement.ledgerBalance}. Проверьте историю и выровняйте корректировкой.`}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
