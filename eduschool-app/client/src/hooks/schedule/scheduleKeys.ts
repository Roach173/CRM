// ─── Cell / session key builders ──────────────────────────────────────────────

export function scKey(ci: number, sid: number): string {
  return `${ci}-${sid}`;
}

export function sessionKey(blockId: number, dateISO: string): string {
  return `${blockId}_${dateISO}`;
}
