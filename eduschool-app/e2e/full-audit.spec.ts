import { test, expect, type Page } from '@playwright/test';
import { login, logout, expectPageHealthy } from './helpers';

/**
 * Whole-site audit: visits every route for every role, capturing console
 * errors, uncaught exceptions, and failed /api/v1 calls; then exercises
 * view-only controls (tabs, filters, search, pagination, modal-open) on
 * each page to catch dead/broken buttons.
 *
 * Safety: never confirms a mutation. DANGEROUS_PATTERNS filters out any
 * clickable whose name suggests delete/pay/send/freeze/save/etc, and the
 * Attendance + Communications/Broadcast + Import-Export routes (credit
 * deduction, real emails, file I/O) are skipped for interaction entirely —
 * visited for the error sweep only, never clicked into.
 */

const DANGEROUS_PATTERNS = [
  /удал/i, /стере/i, /очист/i, /заблокир/i, /разблокир/i,
  /оплат/i, /плат[её]ж/i, /списат/i, /начисл/i,
  /заморо/i, /разморо/i, /отправ/i, /рассыл/i, /разосл/i,
  /подтверд/i, /отмени/i, /сохран/i, /создат/i, /добав/i,
  /назнач/i, /импорт/i, /экспорт/i, /регистрац/i, /выйти/i,
  /submit/i, /delete/i, /\bpay\b/i, /\bsend\b/i, /\bsave\b/i, /confirm/i,
];

const NO_INTERACT_ROUTES = ['attendance', 'communications', 'broadcast', 'import-export'];

const OWNER_ROUTES = ['notifications', 'communications', 'students', 'attendance', 'schedule', 'groups', 'salary', 'finance', 'finance-control', 'design', 'settings', 'import-export', 'staff'];
const ADMIN_ROUTES = ['notifications', 'communications', 'students', 'attendance', 'schedule', 'groups', 'teachers', 'salary', 'finance', 'design', 'settings', 'import-export'];
const TEACHER_ROUTES = ['schedule', 'notifications', 'salary', 'settings'];
const STUDENT_ROUTES = ['dashboard', 'notifications', 'schedule', 'classes'];
const SHARED_ROUTES = ['help', 'profile', 'settings/notifications', 'settings/2fa'];
const SUPERADMIN_ROUTES = ['dashboard', 'schools', 'settings'];

const IGNORE_CONSOLE_PATTERNS = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /WebSocket connection.*failed/i, // dev HMR socket noise, not app logic
];

function attachIssueCollectors(page: Page, issues: string[]) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORE_CONSOLE_PATTERNS.some((re) => re.test(text))) return;
    issues.push(`[console] ${text} @ ${page.url()}`);
  });
  page.on('pageerror', (err) => {
    issues.push(`[pageerror] ${err.message} @ ${page.url()}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && res.url().includes('/api/v1/')) {
      issues.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });
}

async function safeClickSweep(page: Page, issues: string[], startUrl: string, maxClicks = 12) {
  let clicked = 0;
  for (let i = 0; i < 60 && clicked < maxClicks; i++) {
    const buttons = await page.locator('button:visible').all();
    if (i >= buttons.length) break;
    const btn = buttons[i];

    let name = '';
    try {
      name = ((await btn.getAttribute('aria-label')) || (await btn.textContent()) || '').trim();
    } catch {
      continue;
    }
    if (!name) continue;
    if (DANGEROUS_PATTERNS.some((re) => re.test(name))) continue;
    if (await btn.isDisabled().catch(() => true)) continue;

    const urlBefore = page.url();
    const issuesBefore = issues.length;
    try {
      await btn.click({ timeout: 3000 });
      clicked++;
    } catch {
      continue;
    }
    await page.waitForTimeout(250);

    // A confirmation dialog for a destructive action would appear here —
    // never confirm it, just back out.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(100);

    if (issues.length > issuesBefore) {
      issues[issues.length - 1] += ` [after clicking "${name}"]`;
    }

    if (page.url() !== urlBefore) {
      await page.goto(startUrl).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function auditRoutes(page: Page, issues: string[], base: string, routes: string[]) {
  for (const route of routes) {
    const url = `${base}/${route}`;
    await page.goto(url);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await expectPageHealthy(page);

    if (!NO_INTERACT_ROUTES.some((r) => route === r || route.endsWith(`/${r}`))) {
      await safeClickSweep(page, issues, url);
    }
  }
}

function report(issues: string[]) {
  if (issues.length) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ISSUES FOUND (${issues.length}) ===\n${issues.join('\n')}\n`);
  }
  expect(issues, issues.join('\n')).toEqual([]);
}

test.describe('Whole-site audit', () => {
  test('OWNER: full route + interaction sweep', async ({ page }) => {
    const issues: string[] = [];
    attachIssueCollectors(page, issues);
    await login(page, 'admin@test.com', 'admin123');
    const [, slug] = new URL(page.url()).pathname.split('/');
    const base = `/${slug}/owner`;
    await auditRoutes(page, issues, base, OWNER_ROUTES);
    await auditRoutes(page, issues, `/${slug}`, SHARED_ROUTES);
    await logout(page);
    report(issues);
  });

  test('ADMIN: full route + interaction sweep', async ({ page }) => {
    const issues: string[] = [];
    attachIssueCollectors(page, issues);
    await login(page, 'lowadmin@gmail.com', 'admin123');
    const [, slug] = new URL(page.url()).pathname.split('/');
    const base = `/${slug}/admin`;
    await auditRoutes(page, issues, base, ADMIN_ROUTES);
    await auditRoutes(page, issues, `/${slug}`, SHARED_ROUTES);
    await logout(page);
    report(issues);
  });

  test('TEACHER: full route + interaction sweep', async ({ page }) => {
    const issues: string[] = [];
    attachIssueCollectors(page, issues);
    await login(page, 'teacher.import.1.2@import.local', 'school123');
    const [, slug] = new URL(page.url()).pathname.split('/');
    const base = `/${slug}/teacher`;
    await auditRoutes(page, issues, base, TEACHER_ROUTES);
    await auditRoutes(page, issues, `/${slug}`, SHARED_ROUTES);
    await logout(page);
    report(issues);
  });

  test('STUDENT: full route + interaction sweep', async ({ page }) => {
    const issues: string[] = [];
    attachIssueCollectors(page, issues);
    await login(page, 'student1@test.com', '12344321');
    const [, slug] = new URL(page.url()).pathname.split('/');
    const base = `/${slug}/student`;
    await auditRoutes(page, issues, base, STUDENT_ROUTES);
    await auditRoutes(page, issues, `/${slug}`, SHARED_ROUTES);
    await logout(page);
    report(issues);
  });

  test('SUPERADMIN: full route + interaction sweep', async ({ page }) => {
    const issues: string[] = [];
    attachIssueCollectors(page, issues);
    await login(page, 'super@admin.com', 'super123');
    await auditRoutes(page, issues, '/superadmin', SUPERADMIN_ROUTES);
    await logout(page);
    report(issues);
  });
});
