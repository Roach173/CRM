import React, { type ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center animate-in fade-in zoom-in duration-500">
      <div className="w-20 h-20 rounded-[2rem] bg-surfaceLow flex items-center justify-center mb-6 text-textSecondary/40 border border-border/5 shadow-inner">
        {React.isValidElement(icon) ? icon : <span className="text-4xl">{icon}</span>}
      </div>
      <h3 className="text-xl font-bold text-textPrimary mb-2">{title}</h3>
      {description && <p className="text-textSecondary text-sm max-w-[300px] leading-relaxed">{description}</p>}
    </div>
  );
}
