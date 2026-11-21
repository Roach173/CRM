import { useNavigate } from 'react-router';
import { Compass } from 'lucide-react';
import { EmptyState } from '../components/ui/EmptyState';
import { Button } from '../components/ui/Button';

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
      <EmptyState
        icon={<Compass className="w-8 h-8" />}
        title="404 — Страница не найдена"
        description="Похоже, такой страницы не существует или она была перемещена."
      />
      <Button onClick={() => navigate('/')} className="mt-2">
        На главную
      </Button>
    </div>
  );
}
