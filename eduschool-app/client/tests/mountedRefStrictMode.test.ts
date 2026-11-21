import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scheduleDir = resolve(__dirname, '../src/components/schedule');
const filesWithMountedRef = [
  'CreateGroupForm.tsx',
  'EditGroupPanel.tsx',
  'EditSessionPanel.tsx',
  'useGroupRowActions.ts',
];

describe('schedule mountedRef StrictMode guard', () => {
  it('resets mountedRef to true inside the effect body', () => {
    for (const file of filesWithMountedRef) {
      const source = readFileSync(resolve(scheduleDir, file), 'utf8');

      expect(source, file).not.toContain('useEffect(() => () => { mountedRef.current = false; }, [])');
      expect(source, file).toContain('mountedRef.current = true;');
      expect(source, file).toContain('return () => { mountedRef.current = false; };');
    }
  });
});
