import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  collapsed?: boolean;
}

export function ThemeToggle({ collapsed }: Props) {
  const { isDark, toggle } = useTheme();

  return (
    <button
      onClick={toggle}
      title={isDark ? 'Светлая тема' : 'Тёмная тема'}
      className={`flex items-center justify-center text-textSecondary hover:text-primary hover:bg-surfaceLowest rounded-xl transition-colors ${collapsed ? 'w-10 h-10 mx-auto' : 'w-10 h-10'}`}
    >
      {isDark
        ? <Sun className="w-[15px] h-[15px]" />
        : <Moon className="w-[15px] h-[15px]" />
      }
    </button>
  );
}
