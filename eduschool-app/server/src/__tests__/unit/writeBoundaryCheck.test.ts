import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanWriteBoundary } from '../../lib/writeBoundaryCheck';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'write-boundary-'));
}

function writeFile(root: string, relativePath: string, source: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

describe('write-boundary static enforcement', () => {
  it('reports new route Prisma writes as violations', () => {
    const root = makeTempRepo();
    writeFile(root, 'src/routes/newFeature.ts', [
      "import prisma from '../lib/prisma';",
      'export async function run() {',
      '  await prisma.studentProfile.update({ where: { id: 1 }, data: { credits: 0 } });',
      '}',
    ].join('\n'));

    const findings = scanWriteBoundary({ rootDir: root });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: 'src/routes/newFeature.ts',
      allowedByLegacyAllowlist: false,
      newViolation: true,
    });
    expect(findings[0].reasons.map(reason => reason.code)).toContain('PRISMA_SINGLETON_IMPORT');
    expect(findings[0].reasons.map(reason => reason.code)).toContain('DIRECT_PRISMA_MUTATION');
  });

  it('allows future domain owners to use Prisma', () => {
    const root = makeTempRepo();
    writeFile(root, 'src/domain/groups/groupOwner.ts', [
      "import prisma from '../../lib/prisma';",
      'export async function run() {',
      '  await prisma.studentGroup.create({ data: { name: "A", schoolId: 1 } });',
      '}',
    ].join('\n'));

    const findings = scanWriteBoundary({ rootDir: root });

    expect(findings).toEqual([]);
  });

  it('reports legacy allowlisted files without failing them as new violations', () => {
    const root = makeTempRepo();
    writeFile(root, 'src/routes/legacy.ts', [
      "import prisma from '../lib/prisma';",
      'export async function run() {',
      '  await prisma.user.update({ where: { id: 1 }, data: { name: "Legacy" } });',
      '}',
    ].join('\n'));
    writeFile(root, 'write-boundary-allowlist.json', JSON.stringify({
      version: 1,
      legacy: [
        { path: 'src/routes/legacy.ts', owner: 'identity', reason: 'Existing legacy route.' },
      ],
    }));

    const findings = scanWriteBoundary({
      rootDir: root,
      allowlistPath: path.join(root, 'write-boundary-allowlist.json'),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: 'src/routes/legacy.ts',
      allowedByLegacyAllowlist: true,
      newViolation: false,
      owner: 'identity',
      legacyReason: 'Existing legacy route.',
    });
  });
});
