// ─── localStorage helpers (UI preferences only — no business data) ───────────

export function ls<T>(key: string, fallback: T): T {
  try {
    const r = localStorage.getItem(key);
    return r ? (JSON.parse(r) as T) : fallback;
  } catch { return fallback; }
}

export function ss(key: string, val: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}

// Collapsed-section maps (rooms/teachers) were saved under a bare key before
// per-school keys existed; legacyBareKey is a read-only fallback for those
// already-saved preferences and is never written to again.
export function readCollapsedMap(storageKey: string, legacyBareKey: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(storageKey) ?? localStorage.getItem(legacyBareKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
