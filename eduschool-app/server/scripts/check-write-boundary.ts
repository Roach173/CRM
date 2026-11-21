import path from 'path';
import { formatWriteBoundaryReport, scanWriteBoundary } from '../src/lib/writeBoundaryCheck';

const rootDir = path.resolve(__dirname, '..');
const allowlistPath = path.join(rootDir, 'write-boundary-allowlist.json');

const findings = scanWriteBoundary({ rootDir, allowlistPath });
const report = formatWriteBoundaryReport(findings);
const newViolations = findings.filter(finding => finding.newViolation);

console.log(report);

if (newViolations.length > 0) {
  console.error('');
  console.error('Write boundary check failed: new direct Prisma access requires a domain owner or explicit allowlist entry.');
  process.exit(1);
}
