// One color language for lesson type (Grammar vs Speaking Club), shared by every
// student-facing card (Overview's next-lesson card, the Календарь week/month grids)
// so the same badge always means the same thing everywhere.
export const BLOCK_TYPE_LABELS: Record<string, string> = { GRAMMAR: 'Грамматика', SPEAKING_CLUB: 'Разговорный клуб' };

export const BLOCK_TYPE_STYLES: Record<string, { bg: string; fg: string }> = {
  GRAMMAR: { bg: '#E8F5E9', fg: '#1B5E20' },
  SPEAKING_CLUB: { bg: '#E3F2FD', fg: '#1565C0' },
};
