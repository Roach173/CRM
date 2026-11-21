import { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { Upload, Download, FileText, Users, GraduationCap, Calendar, ClipboardList, Database, CheckCircle, AlertTriangle, X, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../../lib/api';
import { usePermissions } from '../../../hooks/usePermissions';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ParsedStudent {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  level?: string;
  chapter?: number;
  credits?: number;
  paidUntil?: string;
  cabinet?: string;
  time?: string;
  grammarTeacher?: string;
  clubTeacher?: string;
  paused?: string;
  notes?: string;
}

interface ParsedTeacher {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

interface Conflict {
  email: string;
  existing: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    studentProfile?: { level?: string; chapter?: number; credits?: number };
  };
  incoming: ParsedStudent | ParsedTeacher;
}

type ImportStage = 'idle' | 'preview' | 'conflicts' | 'applying' | 'done';
type TabKey = 'import' | 'export';
type ImportKind = 'students' | 'teachers' | 'all';
type ConflictResolution = 'update' | 'skip';

// ─── Bios CRM-style parsing ───────────────────────────────────────────────────

// Strip quotes, parenthesized content, and all whitespace before comparing
function normColName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

// Parse paidUntil from Excel cell value (serial number or string/Date), return YYYY-MM-DD or ''
function parsePaidUntilCell(val: unknown): string {
  if (!val && val !== 0) return '';
  // Excel serial number (days since 1900-01-01)
  if (typeof val === 'number') {
    if (val < 1 || val > 2958465) return ''; // outside 1900–9999
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    if (y < 2000 || y > 2100) return '';
    return d.toISOString().slice(0, 10);
  }
  // Date object (xlsx with cellDates:true or raw JS Date)
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    const y = val.getFullYear();
    if (y < 2000 || y > 2100) return '';
    return val.toISOString().slice(0, 10);
  }
  // String
  const s = String(val).trim();
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  if (y < 2000 || y > 2100) return '';
  return d.toISOString().slice(0, 10);
}

// Generic column getter: exact → lowercase → normColName. Also returns which
// header key matched, so a caller can check the column immediately to its
// right (see adjacentUnlabeledValue below).
function xcolWithKey(row: Record<string, unknown>, aliases: string[]): { value: string; key: string } | null {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== '') return { value: String(row[alias]).trim(), key: alias };
    const aliasLower = alias.toLowerCase();
    const aliasNorm = normColName(alias);
    for (const key of keys) {
      if (row[key] === '' || row[key] === undefined) continue;
      if (key.toLowerCase() === aliasLower || normColName(key) === aliasNorm) return { value: String(row[key]).trim(), key };
    }
  }
  return null;
}

function xcol(row: Record<string, unknown>, aliases: string[]): string {
  return xcolWithKey(row, aliases)?.value ?? '';
}

// Some legacy sheets merge a 2-column header (e.g. "Время" over start+end
// time, "Препод" over grammar+club teacher) — only the left column carries
// header text, so sheetToObjects names the right one "col_N". If the matched
// alias's column is immediately followed by such a placeholder, that column
// holds the pair's second value.
function adjacentUnlabeledValue(row: Record<string, unknown>, matchedKey: string): string {
  const keys = Object.keys(row);
  const idx = keys.indexOf(matchedKey);
  if (idx < 0 || idx + 1 >= keys.length) return '';
  const nextKey = keys[idx + 1];
  if (!/^col_\d+$/.test(nextKey)) return '';
  const v = row[nextKey];
  return v === undefined || v === '' ? '' : String(v).trim();
}

// Row objects carry their original sheet row index (0-based, matches the
// header:1 matrix) so a caller can cross-reference per-row cell styling
// (e.g. fill color) that isn't part of the parsed values.
type SheetRow = { row: Record<string, unknown>; rowIndex: number };

// Auto-detect header row (Bios CRM approach), return row objects
export function sheetToObjects(
  sheet: XLSX.WorkSheet,
  requiredAliasGroups: string[][]
): SheetRow[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (!matrix.length) return [];

  let bestHeaderIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < matrix.length; i++) {
    const row = (matrix[i] as unknown[]) || [];
    let score = 0;
    for (const aliases of requiredAliasGroups) {
      const matched = row.some(cell => {
        const cellNorm = normColName(String(cell ?? ''));
        return aliases.some(a => cellNorm && cellNorm === normColName(a));
      });
      if (matched) score++;
    }
    if (score > bestScore) { bestScore = score; bestHeaderIdx = i; }
  }
  if (bestHeaderIdx < 0 || bestScore <= 0) return [];

  const headers = ((matrix[bestHeaderIdx] as unknown[]) || []).map((h, idx) => {
    const hh = String(h ?? '').trim();
    return hh || `col_${idx}`;
  });

  const rows: SheetRow[] = [];
  for (let r = bestHeaderIdx + 1; r < matrix.length; r++) {
    const vals = (matrix[r] as unknown[]) || [];
    const obj: Record<string, unknown> = {};
    let hasAny = false;
    headers.forEach((h, idx) => {
      const v = vals[idx];
      if (v !== '' && v !== null && v !== undefined) hasAny = true;
      obj[h] = v ?? '';
    });
    if (hasAny && !isRepeatedHeaderRow(obj, requiredAliasGroups)) rows.push({ row: obj, rowIndex: r });
  }
  return rows;
}

// Manual red highlighting (dropped/inactive student) reads as a solid fgColor
// where red clearly dominates green/blue — not one exact hex, since schools pick
// whatever red swatch Excel offers them.
function isReddish(argb?: string): boolean {
  if (!argb) return false;
  const hex = argb.slice(-6);
  if (hex.length < 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return false;
  return r >= 140 && r > g * 1.4 && r > b * 1.4;
}

// The xlsx library used for data parsing doesn't read cell styles, so red-row
// detection goes through exceljs instead — best-effort only (legacy .xls, or any
// parse failure, just yields no red rows rather than blocking the import).
async function detectRedRowIndices(buffer: ArrayBuffer, sheetIndex: number): Promise<Set<number>> {
  const redRows = new Set<number>();
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[sheetIndex];
    if (!ws) return redRows;
    ws.eachRow(row => {
      let red = false;
      row.eachCell({ includeEmpty: false }, cell => {
        const fill = cell.fill as ExcelJS.FillPattern | undefined;
        if (fill?.type === 'pattern' && fill.pattern === 'solid' && isReddish((fill.fgColor as any)?.argb)) {
          red = true;
        }
      });
      if (red) redRows.add(row.number - 1); // exceljs rows are 1-based; sheetToObjects indexes 0-based
    });
  } catch {
    // best-effort — unsupported file, ignore
  }
  return redRows;
}

// Sheets built from several stacked mini-tables (one per class group) repeat the
// header row before each block. Without this, a repeated header row gets parsed
// as a garbage "student" whose name is literally the header text.
function isRepeatedHeaderRow(row: Record<string, unknown>, requiredAliasGroups: string[][]): boolean {
  return Object.values(row).some(v => {
    const norm = normColName(String(v ?? ''));
    if (!norm) return false;
    return requiredAliasGroups.some(aliases => aliases.some(a => normColName(a) === norm));
  });
}

// Convert CSV text to row objects (header row auto-detected via same scoring)
function csvToObjects(text: string, requiredAliasGroups: string[][]): SheetRow[] {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  function splitLine(line: string): string[] {
    const result: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
      else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
      else { cur += c; }
    }
    result.push(cur);
    return result;
  }

  // Find best header row (same scoring as sheetToObjects)
  let bestHeaderIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const cols = splitLine(lines[i]);
    let score = 0;
    for (const aliases of requiredAliasGroups) {
      if (cols.some(c => aliases.some(a => normColName(c) === normColName(a)))) score++;
    }
    if (score > bestScore) { bestScore = score; bestHeaderIdx = i; }
  }

  const headers = splitLine(lines[bestHeaderIdx]).map((h, idx) => h.trim() || `col_${idx}`);
  return lines.slice(bestHeaderIdx + 1).map((line, i) => {
    const vals = splitLine(line);
    const obj: Record<string, unknown> = {};
    let hasAny = false;
    headers.forEach((h, idx) => {
      const v = (vals[idx] ?? '').trim();
      if (v) hasAny = true;
      obj[h] = v;
    });
    if (!hasAny || isRepeatedHeaderRow(obj, requiredAliasGroups)) return null;
    return { row: obj, rowIndex: bestHeaderIdx + 1 + i };
  }).filter(Boolean) as SheetRow[];
}

export const STUDENT_REQUIRED = [
  ['Имя', 'Name', 'ФИО', 'Student Name', 'Студент', 'Фамилия Имя Отчество'],
  ['Email', 'E-mail', 'Почта'],
];
const TEACHER_REQUIRED = [
  ['Имя', 'Name', 'ФИО'],
  ['Email', 'E-mail', 'Почта'],
];

// \w is ASCII-only — a pure-Cyrillic name (no email column, common in this format)
// would collapse to '', so every such student got the same placeholder email and
// collided on import. \p{L}/\p{N} keeps letters from any script.
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, '.').replace(/\.+/g, '.').replace(/^\.|\.$/, '');
}

// Matches a bare cabinet/room number written as "№ 7", "#7", "No.7", etc. —
// used when a sheet has no labeled cabinet column but carries the number inline.
const CABINET_VALUE_RE = /^(?:№|#|no\.?)\s*(\d+)$/i;

export function rowsToStudents(rows: SheetRow[], redRowIndices?: Set<number>): ParsedStudent[] {
  return rows.map(({ row, rowIndex }) => {
    let fn = xcol(row, ['Имя', 'Name', 'ФИО', 'ФИО студента', 'Имя ученика', 'Студент', 'Student Name', 'Фамилия Имя Отчество']);
    let ln = xcol(row, ['Фамилия', 'Last Name', 'Lastname', 'Surname', 'Фамилия студента']);
    // "Фамилия Имя Отчество" spells the order out: surname comes first, unlike
    // the "Имя"-led formats where the given name leads.
    const surnameFirst = !!xcol(row, ['Фамилия Имя Отчество']);
    if (!ln && fn && fn.includes(' ')) {
      const parts = fn.trim().split(/\s+/);
      if (surnameFirst) { ln = parts[0]; fn = parts.slice(1).join(' '); }
      else { fn = parts[0]; ln = parts.slice(1).join(' '); }
    }
    if (!fn) return null;
    let email = xcol(row, ['Email', 'E-mail', 'Почта', 'Эл. почта', 'Электронная почта']);
    if (!email) {
      const phone = xcol(row, ['Телефон', 'Phone', 'Тел', 'Номер телефона']).replace(/\D/g, '');
      email = phone ? `tel_${phone}@import.local` : `${slugify(fn)}.${slugify(ln || 'student')}@import.local`;
    }
    const chapterRaw = xcol(row, ['Глава', 'Chapter', 'Чап', 'Chap']);
    const creditsRaw = xcol(row, ['Кредиты', 'Credits', 'Баланс', 'Balance']);

    let cabinet = xcol(row, ['Кабинет', 'Cabinet', 'Room', 'Кабинет/Класс']);
    if (!cabinet) {
      const match = Object.values(row).map(v => String(v ?? '').trim()).find(v => CABINET_VALUE_RE.test(v));
      if (match) cabinet = match.replace(CABINET_VALUE_RE, '$1');
    }

    // Legacy sheets sometimes track a money amount + due date per student instead
    // of a lesson-credit balance. That's a different billing model than EduSchool's
    // credits — never derive credits/paidUntil from it, just carry it as a note
    // for the admin to read.
    const paymentAmount = xcol(row, ['Оплата', 'Payment', 'Сумма']);
    const paymentDate = xcol(row, ['Число', 'Дата оплаты', 'Due Date']);
    const paymentNote = paymentAmount || paymentDate
      ? `Оплата (импорт): ${paymentAmount || '—'}${paymentDate ? `, до ${paymentDate}` : ''}`
      : undefined;

    return {
      firstName: fn,
      lastName: ln || '',
      email: email.toLowerCase(),
      phone: xcol(row, ['Телефон', 'Phone', 'Тел', 'Номер телефона', 'Номер']) || undefined,
      level: xcol(row, ['Уровень', 'Level', 'Lvl']) || undefined,
      chapter: chapterRaw ? parseInt(chapterRaw) || 1 : undefined,
      credits: creditsRaw ? parseInt(creditsRaw) || 0 : undefined,
      paidUntil: (() => {
        const aliases = ['Оплачено до', 'Paid Until', 'Paid Till', 'PaidUntil'];
        const keys = Object.keys(row);
        for (const alias of aliases) {
          if (row[alias] !== undefined && row[alias] !== '') return parsePaidUntilCell(row[alias]) || undefined;
          const found = keys.find(k => k.toLowerCase() === alias.toLowerCase());
          if (found && row[found] !== undefined && row[found] !== '') return parsePaidUntilCell(row[found]) || undefined;
        }
        return undefined;
      })(),
      cabinet: cabinet || undefined,
      time: (() => {
        const m = xcolWithKey(row, ['Время', 'Time', 'TimeSlot', 'Время занятия']);
        if (!m) return undefined;
        if (/[-–—]/.test(m.value)) return m.value; // already "HH:MM-HH:MM" in one cell
        const end = adjacentUnlabeledValue(row, m.key);
        return end ? `${m.value}-${end}` : m.value;
      })(),
      grammarTeacher: (() => {
        const m = xcolWithKey(row, ['Преподаватель грамматики', 'Grammar Teacher', 'Grammar', 'Препод', 'Преподаватель']);
        return m?.value || undefined;
      })(),
      clubTeacher: (() => {
        const named = xcol(row, ['Преподаватель разговорного клуба', 'Club Teacher', 'Speaking Teacher', 'Club']);
        if (named) return named;
        const grammarMatch = xcolWithKey(row, ['Преподаватель грамматики', 'Grammar Teacher', 'Grammar', 'Препод', 'Преподаватель']);
        const adjacent = grammarMatch ? adjacentUnlabeledValue(row, grammarMatch.key) : '';
        return adjacent || undefined;
      })(),
      paused: xcol(row, ['На паузе', 'Paused', 'Пауза', 'Frozen', 'Заморожен']) || (redRowIndices?.has(rowIndex) ? 'true' : undefined),
      notes: paymentNote,
    } as ParsedStudent;
  }).filter(Boolean) as ParsedStudent[];
}

function rowsToTeachers(rows: SheetRow[]): ParsedTeacher[] {
  return rows.map(({ row }) => {
    let fn = xcol(row, ['Имя', 'Name', 'ФИО', 'Имя преподавателя']);
    let ln = xcol(row, ['Фамилия', 'Last Name', 'Lastname', 'Фамилия преподавателя']);
    if (!ln && fn && fn.includes(' ')) {
      const parts = fn.split(' ');
      fn = parts[0];
      ln = parts.slice(1).join(' ');
    }
    if (!fn) return null;
    let email = xcol(row, ['Email', 'E-mail', 'Почта', 'Эл. почта', 'Электронная почта']);
    if (!email) return null; // teachers must have email
    return {
      firstName: fn,
      lastName: ln || '',
      email: email.toLowerCase(),
      phone: xcol(row, ['Телефон', 'Phone', 'Тел', 'Номер телефона', 'Номер']) || undefined,
    } as ParsedTeacher;
  }).filter(Boolean) as ParsedTeacher[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dlFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Export button component ─────────────────────────────────────────────────

function ExportCard({
  icon: Icon,
  title,
  description,
  endpoint,
  filename,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  endpoint: string;
  filename: string;
}) {
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const resp = await api.get(endpoint, { responseType: 'blob' });
      const blob = resp.data as Blob;
      // Guard against the dev-proxy silently returning the SPA's index.html
      // (200 OK, wrong content) instead of a real network/auth error.
      if (blob.type.includes('html')) throw new Error('Unexpected HTML response');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      toast.success(`${title} экспортирован`);
    } catch {
      toast.error('Ошибка экспорта');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={loading}
      className="flex items-start gap-3 w-full text-left px-4 py-3 rounded-2xl border border-border/40 bg-surfaceLowest hover:bg-surfaceLow hover:border-primary/30 transition disabled:opacity-50 group"
    >
      <div className="mt-0.5 p-2 rounded-xl bg-primary/8 text-primary flex-shrink-0 group-hover:bg-primary/15 transition-colors">
        {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-textPrimary leading-tight">{title}</p>
        <p className="text-[10px] text-textSecondary mt-0.5 leading-snug">{description}</p>
      </div>
      <Download className="w-3.5 h-3.5 text-textSecondary/40 ml-auto mt-1 flex-shrink-0 group-hover:text-primary/60 transition-colors" />
    </button>
  );
}

// ─── Import state persistence (survives component unmount/remount) ────────────

type ImportResult = { created: number; updated: number; skipped: number; errors: string[] };

// Module-level Promise: survives unmount within the same JS session (no HMR reset).
// Cleared as soon as the request settles (success or error).
let _activeImport: { promise: Promise<ImportResult>; kind: ImportKind } | null = null;

// sessionStorage helpers: used only as fallback when user returns AFTER the request
// already settled while the component was unmounted.
const _SS = '_ies_';
function ssGet<T>(key: string): T | null {
  try { const v = sessionStorage.getItem(_SS + key); return v !== null ? JSON.parse(v) : null; }
  catch { return null; }
}
function ssSet(key: string, value: unknown): void {
  try { sessionStorage.setItem(_SS + key, JSON.stringify(value)); } catch {}
}
function ssClear(): void {
  ['stage', 'result'].forEach(k => { try { sessionStorage.removeItem(_SS + k); } catch {} });
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ImportExport({ embedded }: { embedded?: boolean } = {}) {
  const { canImport } = usePermissions();
  const [tab, setTab] = useState<TabKey>('export');
  const [importKind, setImportKind] = useState<ImportKind>('all');

  // Import state
  const [stage, setStage] = useState<ImportStage>('idle');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedStudent[]>([]);
  const [parsedTeachers, setParsedTeachers] = useState<ParsedTeacher[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [newCount, setNewCount] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({});
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const [defaultPassword, setDefaultPassword] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // On mount: restore in-flight or completed import state
  useEffect(() => {
    // PRIMARY: promise is still alive in this JS session — subscribe without re-firing
    if (_activeImport) {
      const { promise, kind } = _activeImport;
      setImportKind(kind);
      setStage('applying');

      let active = true;
      promise
        .then(data => { if (active) { setResult(data); setStage('done'); } })
        .catch(() => { if (active) { setStage('idle'); } });

      return () => { active = false; };
    }

    // FALLBACK: request settled while component was unmounted — read persisted result
    const savedStage = ssGet<string>('stage');
    if (savedStage === 'done') {
      const r = ssGet<ImportResult>('result');
      ssClear();
      if (r) { setResult(r); setStage('done'); }
    } else if (savedStage) {
      ssClear(); // stale 'applying' from a previous broken session — discard
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    _activeImport = null;
    ssClear();
    setStage('idle');
    setFileName('');
    setParsed([]);
    setParsedTeachers([]);
    setConflicts([]);
    setNewCount(0);
    setResolutions({});
    setResult(null);
  }

  async function handleFile(file: File) {
    reset();
    setFileName(file.name);

    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const required = importKind === 'teachers' ? TEACHER_REQUIRED : STUDENT_REQUIRED;

      let rows: SheetRow[];
      let redRowIndices: Set<number> | undefined;

      if (ext === 'csv') {
        const text = await file.text();
        rows = csvToObjects(text, required);
      } else if (ext === 'xlsx' || ext === 'xls') {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        // prefer sheet named "Студенты"/"Students", fall back to first sheet
        const sheetName = wb.SheetNames.find(n => /студент|student/i.test(n)) ?? wb.SheetNames[0];
        const sheetIndex = wb.SheetNames.indexOf(sheetName);
        const ws = wb.Sheets[sheetName];
        if (!ws) throw new Error(`Лист не найден: ${sheetName}`);
        rows = sheetToObjects(ws, required);
        if (ext === 'xlsx' && importKind !== 'teachers') {
          redRowIndices = await detectRedRowIndices(buffer, sheetIndex);
        }
      } else {
        toast.error('Поддерживаются только CSV, XLSX, XLS файлы');
        return;
      }

      if (importKind === 'teachers') {
        const teachers = rowsToTeachers(rows);
        if (teachers.length === 0) {
          toast.error('Не найдено ни одной строки. Проверьте заголовки колонок.');
          return;
        }
        setParsedTeachers(teachers);
        const resp = await api.post('/import-export/import/preview-teachers', { teachers });
        const { conflicts: cfls, newCount: nc } = resp.data.data;
        setConflicts(cfls);
        setNewCount(nc);
        const res: Record<string, ConflictResolution> = {};
        cfls.forEach((c: Conflict) => { res[c.email] = 'skip'; });
        setResolutions(res);
      } else {
        // 'students' and 'all' both use student parser (includes schedule columns)
        const students = rowsToStudents(rows, redRowIndices);
        if (students.length === 0) {
          toast.error('Не найдено ни одной строки. Проверьте заголовки колонок.');
          return;
        }
        setParsed(students);
        if (redRowIndices?.size) {
          toast(`${redRowIndices.size} строк(и) с красной заливкой помечены «на паузе»`, { icon: '🔴' });
        }
        const resp = await api.post('/import-export/import/preview', { students });
        const { conflicts: cfls, newCount: nc } = resp.data.data;
        setConflicts(cfls);
        setNewCount(nc);
        const res: Record<string, ConflictResolution> = {};
        cfls.forEach((c: Conflict) => { res[c.email] = 'skip'; });
        setResolutions(res);
      }

      setStage('preview');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || String(err);
      toast.error(`Ошибка: ${msg}`);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function setResolution(email: string, value: ConflictResolution) {
    setResolutions(prev => ({ ...prev, [email]: value }));
  }

  function setAllResolutions(value: ConflictResolution) {
    const res: Record<string, ConflictResolution> = {};
    conflicts.forEach(c => { res[c.email] = value; });
    setResolutions(res);
  }

  async function applyImport() {
    setStage('applying');

    const knd = importKind;
    const promise: Promise<ImportResult> = (knd === 'teachers'
      ? api.post('/import-export/import/apply-teachers', { teachers: parsedTeachers, resolutions, defaultPassword })
      : api.post('/import-export/import/apply', { students: parsed, resolutions, defaultPassword })
    ).then(resp => resp.data.data as ImportResult);

    // Store at module level so unmount/remount can subscribe without re-firing
    _activeImport = { promise, kind: knd };
    // Also write to sessionStorage so the request result can be read after it settles
    ssSet('stage', 'applying');

    try {
      const data = await promise;
      _activeImport = null;
      ssSet('stage', 'done');
      ssSet('result', data);
      setResult(data);
      setStage('done');
    } catch (err: any) {
      _activeImport = null;
      ssClear();
      const msg = err?.response?.data?.error || err?.message || 'Неизвестная ошибка';
      toast.error(`Ошибка импорта: ${msg}`);
      setStage('preview');
    }
  }

  function handleExampleDownload() {
    if (importKind === 'teachers') {
      const csv = 'Имя,Фамилия,Email,Телефон\nАлексей,Петров,alexey@example.com,+996700111222\nМария,Сидорова,maria@example.com,+996700333444';
      dlFile('import_teachers_example.csv', csv, 'text/csv;charset=utf-8;');
    } else if (importKind === 'all') {
      const csv = 'Имя,Фамилия,Email,Телефон,Уровень,Глава,Кредиты,Кабинет,Время,Преподаватель грамматики,Преподаватель разговорного клуба,На паузе\nИван,Иванов,ivan@example.com,+996700123456,B1,5,0,101,09:40-11:00,Алексей Петров,Мария Сидорова,\nАнна,Смирнова,anna@example.com,+996700654321,A2,3,0,102,11:10-12:30,Алексей Петров,,нет';
      dlFile('import_all_example.csv', csv, 'text/csv;charset=utf-8;');
    } else {
      const csv = 'Имя,Фамилия,Email,Телефон,Уровень,Глава,Кредиты\nИван,Иванов,ivan@example.com,+996700123456,B1,5,0\nАнна,Смирнова,anna@example.com,+996700654321,A2,3,0';
      dlFile('import_example.csv', csv, 'text/csv;charset=utf-8;');
    }
  }

  return (
    <div className={embedded ? 'space-y-6' : 'max-w-3xl mx-auto space-y-6'}>
      {/* Header */}
      {!embedded && (
        <div>
          <h1 className="font-serif text-2xl text-textPrimary">Импорт / Экспорт</h1>
          <p className="text-textSecondary text-sm mt-0.5">Перенос данных в систему и из неё</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-surfaceLowest border border-border/30 rounded-2xl p-1 w-fit">
        {(['export', 'import'] as TabKey[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-widest transition ${
              tab === t ? 'bg-primary text-white shadow-sm' : 'text-textSecondary hover:text-textPrimary'
            }`}
          >
            {t === 'export' ? 'Экспорт' : 'Импорт'}
          </button>
        ))}
      </div>

      {/* ── EXPORT TAB ── */}
      {tab === 'export' && (
        <div className="space-y-3">
          <p className="text-[11px] text-textSecondary uppercase tracking-widest font-bold">Данные школы</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <ExportCard
              icon={Users}
              title="Студенты"
              description="Список студентов с уровнем, кредитами, преподавателями, кабинетом и временем"
              endpoint={`/import-export/export/students`}
              filename={`students_${today()}.csv`}
            />
            <ExportCard
              icon={GraduationCap}
              title="Преподаватели"
              description="Список преподавателей с количеством групп"
              endpoint={`/import-export/export/teachers`}
              filename={`teachers_${today()}.csv`}
            />
            <ExportCard
              icon={Calendar}
              title="Расписание"
              description="Все группы: кабинет, время, дни, учителя, студентов"
              endpoint={`/import-export/export/schedule`}
              filename={`schedule_${today()}.csv`}
            />
            <ExportCard
              icon={ClipboardList}
              title="Посещаемость"
              description="Записи за последние 30 дней"
              endpoint={`/import-export/export/attendance`}
              filename={`attendance_${today()}.csv`}
            />
            <ExportCard
              icon={FileText}
              title="Зарплата (текущий месяц)"
              description="Количество уроков и замен по преподавателям"
              endpoint={`/import-export/export/salary`}
              filename={`salary_${today()}.csv`}
            />
            <ExportCard
              icon={Database}
              title="Полный бэкап (JSON)"
              description="Все данные школы в формате JSON для резервного копирования"
              endpoint={`/import-export/export/backup`}
              filename={`school_backup_${today()}.json`}
            />
          </div>
        </div>
      )}

      {/* ── IMPORT TAB (owner/superadmin only — data:import server-side) ── */}
      {tab === 'import' && !canImport && (
        <div className="rounded-2xl border border-border/30 bg-surfaceLowest p-6 text-sm text-textSecondary">
          Импорт данных доступен только владельцу школы.
        </div>
      )}
      {tab === 'import' && canImport && (
        <div className="space-y-4">

          {/* IDLE — drop zone */}
          {stage === 'idle' && (
            <div className="space-y-3">
              {/* Kind toggle */}
              <div className="flex gap-1 bg-surfaceLowest border border-border/30 rounded-xl p-1 w-fit">
                {([['all', 'Всё сразу'], ['students', 'Студенты'], ['teachers', 'Преподаватели']] as [ImportKind, string][]).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setImportKind(k)}
                    className={`px-4 py-1 rounded-lg text-[11px] font-bold uppercase tracking-widest transition ${
                      importKind === k ? 'bg-primary text-white shadow-sm' : 'text-textSecondary hover:text-textPrimary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <p className="text-[11px] text-textSecondary uppercase tracking-widest font-bold">
                  {importKind === 'all' ? 'Импорт всех данных' : importKind === 'students' ? 'Импорт студентов' : 'Импорт преподавателей'}
                </p>
                <button onClick={handleExampleDownload} className="text-[10px] text-primary hover:underline flex items-center gap-1">
                  <Download className="w-3 h-3" /> Скачать пример CSV
                </button>
              </div>

              {/* Supported columns info */}
              <div className="bg-surfaceLowest border border-border/30 rounded-2xl px-4 py-3 text-[10px] text-textSecondary space-y-1">
                <p className="font-bold text-textPrimary text-[11px] mb-1">Поддерживаемые колонки</p>
                {importKind === 'all' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                    <span><span className="text-primary">Имя</span> / First Name</span>
                    <span><span className="text-primary">Фамилия</span> / Last Name</span>
                    <span><span className="text-primary">Email</span> — обязательно</span>
                    <span><span className="text-primary">Телефон</span> / Phone</span>
                    <span><span className="text-primary">Уровень</span> / Level</span>
                    <span><span className="text-primary">Глава</span> / Chapter</span>
                    <span><span className="text-primary">Кредиты</span> / Credits</span>
                    <span><span className="text-primary">Кабинет</span> / Cabinet</span>
                    <span><span className="text-primary">Время</span> / Time</span>
                    <span><span className="text-primary">Преподаватель грамматики</span></span>
                    <span><span className="text-primary">Преподаватель разговорного клуба</span></span>
                    <span><span className="text-primary">На паузе</span> / Paused</span>
                    <span><span className="text-primary">Фамилия Имя Отчество</span> (вместо Имя+Фамилия)</span>
                    <span><span className="text-primary">Оплата</span> + <span className="text-primary">Число</span> → заметка в профиле</span>
                  </div>
                ) : importKind === 'students' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                    <span><span className="text-primary">Имя</span> / First Name</span>
                    <span><span className="text-primary">Фамилия</span> / Last Name</span>
                    <span><span className="text-primary">Email</span> — обязательно</span>
                    <span><span className="text-primary">Телефон</span> / Phone</span>
                    <span><span className="text-primary">Уровень</span> / Level</span>
                    <span><span className="text-primary">Глава</span> / Chapter</span>
                    <span><span className="text-primary">Кредиты</span> / Credits</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                    <span><span className="text-primary">Имя</span> / First Name</span>
                    <span><span className="text-primary">Фамилия</span> / Last Name</span>
                    <span><span className="text-primary">Email</span> — обязательно</span>
                    <span><span className="text-primary">Телефон</span> / Phone</span>
                  </div>
                )}
                <p className="mt-1 text-textSecondary/60">Форматы: CSV, XLSX, XLS. Названия колонок распознаются гибко (рус/англ, разный порядок), несколько таблиц с повторяющимся заголовком на одном листе — тоже ок.</p>
              </div>

              {/* Drop zone */}
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl flex flex-col items-center justify-center py-12 cursor-pointer transition ${
                  dragOver
                    ? 'border-primary bg-primary/5 scale-[1.01]'
                    : 'border-border/40 hover:border-primary/40 hover:bg-surfaceLowest'
                }`}
              >
                <Upload className={`w-8 h-8 mb-3 transition-colors ${dragOver ? 'text-primary' : 'text-textSecondary/40'}`} />
                <p className="text-sm font-medium text-textPrimary">Перетащите файл или нажмите для выбора</p>
                <p className="text-[10px] text-textSecondary mt-1">CSV, XLSX, XLS</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
                />
              </div>
            </div>
          )}

          {/* PREVIEW */}
          {stage === 'preview' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-textSecondary uppercase tracking-widest font-bold">Предпросмотр</p>
                <button onClick={reset} className="text-[10px] text-textSecondary hover:text-primary flex items-center gap-1">
                  <X className="w-3 h-3" /> Сбросить
                </button>
              </div>

              {/* File + summary */}
              <div className="bg-surfaceLowest border border-border/30 rounded-2xl px-4 py-3 space-y-2">
                <p className="text-xs font-semibold text-textPrimary flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-primary" /> {fileName}
                </p>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {[
                    { label: 'Всего строк', value: importKind === 'teachers' ? parsedTeachers.length : parsed.length, color: 'text-textPrimary' },
                    { label: 'Новых', value: newCount, color: 'text-green-600' },
                    { label: 'Конфликтов', value: conflicts.length, color: conflicts.length > 0 ? 'text-amber-500' : 'text-textPrimary' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-background border border-border/20 rounded-xl px-3 py-2 text-center">
                      <p className={`text-base font-bold ${color}`}>{value}</p>
                      <p className="text-[10px] text-textSecondary">{label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Password for new students */}
              <div className="bg-surfaceLowest border border-border/30 rounded-2xl px-4 py-3 space-y-2">
                <p className="text-[10px] font-bold text-textSecondary uppercase tracking-widest">
                  {importKind === 'teachers' ? 'Пароль для новых преподавателей' : 'Пароль для новых студентов'}
                </p>
                {importKind === 'all' && (
                  <p className="text-[10px] text-textSecondary/60">Студенты, кабинеты и группы будут созданы автоматически</p>
                )}
                <input
                  type="text"
                  value={defaultPassword}
                  onChange={e => setDefaultPassword(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-background border border-border/40 text-textPrimary focus:outline-none focus:border-primary/50"
                  placeholder="Минимум 8 символов"
                />
                <p className="text-[10px] text-textSecondary/60">Студенты смогут сменить пароль после входа</p>
              </div>

              {/* Conflicts preview */}
              {conflicts.length > 0 && (
                <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200/50 rounded-2xl px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <p className="text-xs font-semibold text-textPrimary">{conflicts.length} конфликт(а) — выберите действие</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setAllResolutions('skip')} className="text-[10px] px-3 py-1 rounded-lg border border-border/40 bg-background hover:bg-surfaceLow transition-colors">Пропустить все</button>
                    <button onClick={() => setAllResolutions('update')} className="text-[10px] px-3 py-1 rounded-lg border border-border/40 bg-background hover:bg-surfaceLow transition-colors">Обновить все</button>
                  </div>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {conflicts.map(c => (
                      <div key={c.email} className="bg-background border border-border/20 rounded-xl px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-[10px] space-y-0.5 min-w-0">
                            <p className="font-semibold text-textPrimary truncate">{c.email}</p>
                            <p className="text-textSecondary">В базе: {c.existing.firstName} {c.existing.lastName} | Уровень: {c.existing.studentProfile?.level || '—'}</p>
                            <p className="text-primary">Файл: {c.incoming.firstName} {c.incoming.lastName} | Уровень: {('level' in c.incoming ? c.incoming.level : null) || '—'}</p>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              onClick={() => setResolution(c.email, 'skip')}
                              className={`text-[9px] px-2 py-1 rounded-lg font-bold uppercase tracking-wide transition-colors ${
                                resolutions[c.email] === 'skip' ? 'bg-border text-textPrimary' : 'bg-background border border-border/40 text-textSecondary hover:bg-surfaceLow'
                              }`}
                            >Пропустить</button>
                            <button
                              onClick={() => setResolution(c.email, 'update')}
                              className={`text-[9px] px-2 py-1 rounded-lg font-bold uppercase tracking-wide transition-colors ${
                                resolutions[c.email] === 'update' ? 'bg-primary text-white' : 'bg-background border border-border/40 text-textSecondary hover:bg-surfaceLow'
                              }`}
                            >Обновить</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={applyImport}
                className="w-full py-2.5 bg-primary text-white text-xs font-bold uppercase tracking-widest rounded-2xl hover:opacity-90 transition-opacity"
              >
                Применить импорт ({newCount} новых{conflicts.length > 0 ? `, ${Object.values(resolutions).filter(v => v === 'update').length} обновить` : ''})
              </button>
            </div>
          )}

          {/* APPLYING */}
          {stage === 'applying' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <RefreshCw className="w-8 h-8 text-primary animate-spin" />
              <p className="text-sm text-textSecondary">Применяем импорт…</p>
            </div>
          )}

          {/* DONE */}
          {stage === 'done' && result && (
            <div className="space-y-4">
              <div className="bg-surfaceLowest border border-border/30 rounded-2xl px-4 py-4 space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  <p className="text-sm font-semibold text-textPrimary">Импорт завершён</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: 'Создано', value: result.created, color: 'text-green-600' },
                    { label: 'Обновлено', value: result.updated, color: 'text-blue-500' },
                    { label: 'Пропущено', value: result.skipped, color: 'text-textSecondary' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-background border border-border/20 rounded-xl px-3 py-2 text-center">
                      <p className={`text-base font-bold ${color}`}>{value}</p>
                      <p className="text-[10px] text-textSecondary">{label}</p>
                    </div>
                  ))}
                </div>
                {result.errors.length > 0 && (
                  <div className="bg-red-50 dark:bg-red-900/10 border border-red-200/40 rounded-xl px-3 py-2">
                    <p className="text-[10px] font-bold text-red-500 mb-1">Ошибки ({result.errors.length})</p>
                    <div className="space-y-0.5 max-h-24 overflow-y-auto">
                      {result.errors.map((e, i) => <p key={i} className="text-[10px] text-red-400">{e}</p>)}
                    </div>
                  </div>
                )}
              </div>
              <button onClick={reset} className="w-full py-2.5 border border-border/40 text-xs font-bold uppercase tracking-widest rounded-2xl hover:bg-surfaceLowest transition-colors text-textSecondary">
                Импортировать ещё
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
