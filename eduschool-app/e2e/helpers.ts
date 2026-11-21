import { type Page, expect } from '@playwright/test';

export const ERROR_BOUNDARY_TEXT = 'Что-то пошло не так';

export async function expectPageHealthy(page: Page) {
  await expect(page.getByText(ERROR_BOUNDARY_TEXT)).not.toBeVisible();
  await expect(page.locator('body')).not.toBeEmpty();
}

export async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  await expectPageHealthy(page);
}

export async function logout(page: Page) {
  // Sidebar renders logout as icon-only (aria-label) or icon+text depending on
  // collapsed/mobile state — match by accessible name and pick whichever
  // candidate is actually visible/on-screen rather than assuming a single match.
  const candidates = await page.getByRole('button', { name: 'Выйти' }).all();
  for (const candidate of candidates) {
    if (await candidate.isVisible()) {
      await candidate.click();
      await page.waitForURL((url) => url.pathname.endsWith('/login') || url.pathname === '/', { timeout: 15000 });
      return;
    }
  }
  throw new Error('No visible logout button found');
}
