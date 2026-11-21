export function encodeCursor(id: number): string {
  return Buffer.from(String(id)).toString('base64');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const id = parseInt(Buffer.from(cursor, 'base64').toString('utf-8'));
    return isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function buildCursorPage<T extends { id: number }>(
  items: T[],
  take: number
): CursorPage<T> {
  const hasMore = items.length > take;
  const data = hasMore ? items.slice(0, take) : items;
  const nextCursor = hasMore ? encodeCursor(data[data.length - 1].id) : null;
  return { data, nextCursor, hasMore };
}
