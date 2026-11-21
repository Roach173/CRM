import { C } from './scheduleTheme';

interface SlotPanelFooterProps {
  isTeacher?: boolean;
  addBlockDisabledReason?: string | null;
  onAddBlock: () => void;
  allExpanded: boolean;
  onToggleAll: () => void;
  isMobile?: boolean;
}

// Pure presentational footer — "add block" CTA (disabled with a reason when
// read-only/historical/out-of-grid) and the expand/collapse-all toggle.
export function SlotPanelFooter({
  isTeacher, addBlockDisabledReason, onAddBlock, allExpanded, onToggleAll, isMobile = false,
}: SlotPanelFooterProps) {
  // Mobile: buttons split the row evenly so both are thumb-sized instead of two
  // small pills hugging opposite edges.
  const grow = isMobile ? { flex: 1, justifyContent: 'center' as const, minHeight: 44 } : {};
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: isTeacher ? 'flex-end' : 'space-between', gap: 8, flexWrap: 'wrap', padding: isMobile ? '10px 12px' : '10px 16px', borderTop: `1px solid ${C.border}`, flexShrink: 0, background: C.bg }}>
      {!isTeacher && (
        <button
          onClick={() => { if (!addBlockDisabledReason) onAddBlock(); }}
          disabled={Boolean(addBlockDisabledReason)}
          title={addBlockDisabledReason ?? undefined}
          style={{ minHeight: 38, padding: '7px 14px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, cursor: addBlockDisabledReason ? 'not-allowed' : 'pointer', color: addBlockDisabledReason ? C.light : C.text, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5, opacity: addBlockDisabledReason ? 0.6 : 1, ...grow }}
        >
          + Добавить блок
        </button>
      )}
      <button onClick={onToggleAll} style={{ minHeight: 38, padding: '7px 14px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, cursor: 'pointer', color: C.mid, ...grow }}>
        {allExpanded ? 'Свернуть все' : 'Развернуть все'}
      </button>
    </div>
  );
}
