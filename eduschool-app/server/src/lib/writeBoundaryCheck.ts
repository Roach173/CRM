import fs from 'fs';
import path from 'path';

export interface AllowlistEntry {
  path: string;
  owner: string;
  reason: string;
}

export interface AllowlistConfig {
  version: number;
  description?: string;
  legacy: AllowlistEntry[];
}

export interface BoundaryReason {
  code: string;
  line: number;
  detail: string;
}

export interface BoundaryFinding {
  path: string;
  reasons: BoundaryReason[];
  allowedByLegacyAllowlist: boolean;
  legacyReason?: string;
  owner?: string;
  newViolation: boolean;
}

export interface ScanOptions {
  rootDir: string;
  allowlistPath?: string;
  scanRoots?: string[];
}

const DEFAULT_SCAN_ROOTS = ['src', 'scripts', 'prisma'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const MUTATION_METHODS = 'create|createMany|update|updateMany|upsert|delete|deleteMany';

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function normalizeRelative(rootDir: string, filePath: string): string {
  return toPosix(path.relative(rootDir, filePath));
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function isSkippedDirectory(name: string): boolean {
  return ['node_modules', 'dist', 'coverage', '.git'].includes(name);
}

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDirectory(entry.name)) out.push(...collectFiles(entryPath));
      continue;
    }
    if (entry.isFile() && isSourceFile(entryPath)) out.push(entryPath);
  }
  return out;
}

function isApprovedZone(relativePath: string): boolean {
  return (
    relativePath === 'src/lib/prisma.ts' ||
    relativePath.startsWith('src/domain/') ||
    relativePath.startsWith('src/infra/') ||
    relativePath.startsWith('src/__tests__/') ||
    relativePath.startsWith('prisma/migrations/')
  );
}

function loadAllowlist(allowlistPath?: string): Map<string, AllowlistEntry> {
  if (!allowlistPath || !fs.existsSync(allowlistPath)) return new Map();

  const parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) as AllowlistConfig;
  return new Map(parsed.legacy.map(entry => [toPosix(entry.path), entry]));
}

function addReason(reasons: BoundaryReason[], code: string, line: number, detail: string): void {
  if (reasons.some(reason => reason.code === code && reason.line === line && reason.detail === detail)) return;
  reasons.push({ code, line, detail });
}

function detectReasons(source: string): BoundaryReason[] {
  const reasons: BoundaryReason[] = [];
  const lines = source.split(/\r?\n/);
  const hasPrismaAccess = /from\s+['"].*lib\/prisma['"]|require\(['"].*lib\/prisma['"]\)|new\s+PrismaClient\s*\(/.test(source);

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    if (/from\s+['"].*lib\/prisma['"]|require\(['"].*lib\/prisma['"]\)/.test(line)) {
      addReason(reasons, 'PRISMA_SINGLETON_IMPORT', lineNo, line.trim());
    }

    if (/new\s+PrismaClient\s*\(/.test(line)) {
      addReason(reasons, 'PRISMA_CLIENT_CONSTRUCTION', lineNo, line.trim());
    }

    const mutationPattern = new RegExp(`\\b(?:prisma|tx|client|dbClient|prismaDefault|p)\\.[A-Za-z][A-Za-z0-9_]*\\.(${MUTATION_METHODS})\\b`, 'g');
    for (const match of line.matchAll(mutationPattern)) {
      addReason(reasons, 'DIRECT_PRISMA_MUTATION', lineNo, match[0]);
    }

    if (hasPrismaAccess && /\b(connect|disconnect)\s*:/.test(line)) {
      addReason(reasons, 'NESTED_RELATION_MUTATION', lineNo, line.trim());
    }
  });

  return reasons;
}

export function scanWriteBoundary(options: ScanOptions): BoundaryFinding[] {
  const rootDir = path.resolve(options.rootDir);
  const allowlist = loadAllowlist(options.allowlistPath);
  const scanRoots = options.scanRoots ?? DEFAULT_SCAN_ROOTS;
  const files = scanRoots.flatMap(scanRoot => collectFiles(path.join(rootDir, scanRoot)));
  const findings: BoundaryFinding[] = [];

  for (const file of files) {
    const relativePath = normalizeRelative(rootDir, file);
    const reasons = detectReasons(fs.readFileSync(file, 'utf8'));
    if (reasons.length === 0 || isApprovedZone(relativePath)) continue;

    const legacyEntry = allowlist.get(relativePath);
    findings.push({
      path: relativePath,
      reasons,
      allowedByLegacyAllowlist: Boolean(legacyEntry),
      legacyReason: legacyEntry?.reason,
      owner: legacyEntry?.owner,
      newViolation: !legacyEntry,
    });
  }

  return findings.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatWriteBoundaryReport(findings: BoundaryFinding[]): string {
  const lines: string[] = [];
  const newViolations = findings.filter(finding => finding.newViolation);
  const legacy = findings.filter(finding => finding.allowedByLegacyAllowlist);

  lines.push('ERP write-boundary static enforcement report');
  lines.push(`New violations: ${newViolations.length}`);
  lines.push(`Legacy allowlisted files: ${legacy.length}`);
  lines.push('');

  for (const finding of findings) {
    lines.push(`${finding.path}`);
    lines.push(`  allowedByLegacyAllowlist: ${finding.allowedByLegacyAllowlist ? 'YES' : 'NO'}`);
    lines.push(`  newViolation: ${finding.newViolation ? 'YES' : 'NO'}`);
    if (finding.owner) lines.push(`  owner: ${finding.owner}`);
    if (finding.legacyReason) lines.push(`  legacyReason: ${finding.legacyReason}`);
    for (const reason of finding.reasons) {
      lines.push(`  reason: ${reason.code} line ${reason.line} - ${reason.detail}`);
    }
  }

  if (findings.length === 0) {
    lines.push('No direct Prisma write-boundary findings.');
  }

  return lines.join('\n');
}
