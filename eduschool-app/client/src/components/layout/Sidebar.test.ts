import { describe, expect, it } from 'vitest';
import {
  getMobileBottomNav,
  getNavigation,
  getProfileDropdownLinks,
} from './Sidebar';

const roles = ['OWNER', 'ADMIN', 'TEACHER', 'STUDENT', 'PARENT'] as const;

function hrefs(items: Array<{ href: string }>) {
  return items.map(item => item.href);
}

describe('sidebar role navigation', () => {
  it('shows notifications to every school role', () => {
    for (const role of roles) {
      const items = getNavigation({ role }, 'school');

      expect(hrefs(items)).toContain(`/school/${role.toLowerCase()}/notifications`);
    }
  });

  it('shows full communications only to owner and admin', () => {
    expect(hrefs(getNavigation({ role: 'OWNER' }, 'school'))).toContain('/school/owner/communications');
    expect(hrefs(getNavigation({ role: 'ADMIN' }, 'school'))).toContain('/school/admin/communications');

    for (const role of ['TEACHER', 'STUDENT', 'PARENT'] as const) {
      expect(hrefs(getNavigation({ role }, 'school'))).not.toContain(`/school/${role.toLowerCase()}/communications`);
    }
  });

  it('keeps notification access in mobile navigation for teacher, student, and parent', () => {
    for (const role of ['TEACHER', 'STUDENT', 'PARENT'] as const) {
      const items = getMobileBottomNav({ role }, 'school');

      expect(hrefs(items)).toContain(`/school/${role.toLowerCase()}/notifications`);
      expect(hrefs(items)).not.toContain(`/school/${role.toLowerCase()}/communications`);
    }
  });

  it('only offers a separate "Настройки" link to roles with something to configure beyond their profile', () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      expect(hrefs(getProfileDropdownLinks('school', role))).toContain(`/school/${role.toLowerCase()}/settings`);
    }
    // Teacher and student have nothing to configure beyond personal profile/2FA/notifications
    // (see /profile) — a separate "Настройки" page just duplicated it.
    for (const role of ['TEACHER', 'STUDENT'] as const) {
      expect(hrefs(getProfileDropdownLinks('school', role))).not.toContain(`/school/${role.toLowerCase()}/settings`);
    }
  });

  it('exposes notification preferences from the profile dropdown for every school role', () => {
    for (const role of roles) {
      const items = getProfileDropdownLinks('school', role);

      expect(items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'Настройки уведомлений',
          href: '/school/settings/notifications',
        }),
      ]));
    }
  });
});
