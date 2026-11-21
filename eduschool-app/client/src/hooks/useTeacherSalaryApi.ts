import { useState, useCallback, useEffect } from 'react';
import api from '../lib/api';
import type { TeacherSalaryData } from './useSalaryApi';

export function useTeacherSalaryApi(period: string) {
  const [data, setData] = useState<TeacherSalaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/salary/my', { params: { period } });
      setData(res.data?.data ?? null);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load };
}
