import { useState, useEffect } from 'react';

type Theme = 'light' | 'dark';

function getInitial(): Theme {
  try {
    const stored = localStorage.getItem('school_theme') as Theme | null;
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try { localStorage.setItem('school_theme', theme); } catch {}
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitial);

  useEffect(() => { applyTheme(theme); }, [theme]);

  function toggle() {
    setTheme(t => (t === 'light' ? 'dark' : 'light'));
  }

  return { theme, toggle, isDark: theme === 'dark' };
}
