import { test, expect } from '@playwright/test';
import { login, logout, expectPageHealthy } from './helpers';

// Uses the built-in DEV_ACCOUNTS matrix already wired into the login page's
// dev-only autologin panel (client/src/pages/Login.tsx) — same accounts, same
// passwords, no new fixtures needed.
const ROLES = [
  {
    role: 'OWNER',
    email: 'admin@test.com',
    password: 'admin123',
    pages: ['students', 'schedule', 'salary', 'finance'],
  },
  {
    role: 'ADMIN',
    email: 'lowadmin@gmail.com',
    password: 'admin123',
    pages: ['students', 'schedule', 'teachers', 'salary'],
  },
  {
    role: 'TEACHER',
    email: 'teacher.import.1.2@import.local',
    password: 'school123',
    pages: ['schedule', 'salary'],
  },
  {
    role: 'STUDENT',
    email: 'student1@test.com',
    password: '12344321',
    pages: ['dashboard', 'schedule', 'classes'],
  },
] as const;

test.describe('Auth + role smoke walkthrough', () => {
  for (const account of ROLES) {
    test(`${account.role}: login, visit main pages, logout`, async ({ page }) => {
      await login(page, account.email, account.password);

      const url = new URL(page.url());
      const [, slug, roleSegment] = url.pathname.split('/');
      expect(slug, 'expected redirect to include a school slug').toBeTruthy();
      expect(roleSegment.toUpperCase()).toBe(account.role);

      for (const p of account.pages) {
        await page.goto(`/${slug}/${roleSegment}/${p}`);
        await expectPageHealthy(page);
      }

      await logout(page);
    });
  }

  test('SUPERADMIN: login, visit main pages, logout', async ({ page }) => {
    await login(page, 'super@admin.com', 'super123');
    expect(page.url()).toContain('/superadmin/dashboard');

    for (const p of ['schools', 'settings']) {
      await page.goto(`/superadmin/${p}`);
      await expectPageHealthy(page);
    }

    await logout(page);
  });

  test('invalid credentials are rejected', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('admin@test.com');
    await page.locator('#password').fill('wrong-password');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
