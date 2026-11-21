import { C } from './scheduleTheme';

interface LogEntry {
  id: number;
  createdAt: string;
  details: string;
  user: { firstName: string; lastName: string };
}

interface EditSessionChangeLogProps {
  show: boolean;
  loading: boolean;
  logs: LogEntry[];
}

// Pure presentational — showLogs/logs state and the fetch live in EditSessionPanel.
export function EditSessionChangeLog({ show, loading, logs }: EditSessionChangeLogProps) {
  if (!show) return null;
  return (
    <div style={{
      background: C.bgLight, borderRadius: 8, padding: '10px 12px', marginBottom: 12,
      border: `1px solid ${C.border}`, maxHeight: 200, overflowY: 'auto',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.mid, textTransform: 'uppercase', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>История изменений</span>
        {loading && <span style={{ opacity: 0.6 }}>Загрузка...</span>}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {!loading && logs.length === 0 && (
          <div style={{ fontSize: 11, color: C.light, textAlign: 'center', padding: '5px 0' }}>Изменений не зафиксировано</div>
        )}
        {logs.map((log) => (
          <div key={log.id} style={{ fontSize: 11, borderLeft: `2px solid ${C.primary}`, padding: '2px 0 2px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontWeight: 700, color: C.text }}>{log.user.firstName} {log.user.lastName}</span>
              <span style={{ color: C.light }}>{new Date(log.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div style={{ color: C.mid, lineHeight: 1.3 }}>{log.details}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
