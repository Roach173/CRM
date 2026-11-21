// Prefetch the heavy dashboard page chunks during browser idle time so that switching
// pages (e.g. Schedule -> Groups) is instant instead of waiting for the lazy chunk to
// download on tap. This matters most on mobile: there is no hover to trigger prefetch,
// and tunnelled/slow networks make that first chunk fetch the visible "loading" delay.
//
// Each thunk MUST use the same module specifier as the corresponding React.lazy import in
// router/index.tsx, so Vite resolves the identical chunk (no duplicate download).

type Thunk = () => Promise<unknown>;

const COMMON_DASHBOARD: Thunk[] = [
  () => import('../pages/dashboard/admin/Schedule'),
  () => import('../pages/dashboard/admin/Groups'),
  () => import('../pages/dashboard/admin/Students'),
  () => import('../pages/dashboard/admin/Attendance'),
];

const BY_ROLE: Record<string, Thunk[]> = {
  OWNER: COMMON_DASHBOARD,
  ADMIN: COMMON_DASHBOARD,
  TEACHER: [() => import('../pages/dashboard/teacher/TeacherSchedule')],
  STUDENT: [
    () => import('../pages/dashboard/student/Schedule'),
    () => import('../pages/dashboard/student/Overview'),
  ],
};

let started = false;

// Load chunks one at a time so prefetch never contends with the current page's own data
// fetch for bandwidth. Failures are swallowed — the real navigation will retry the import.
async function loadSequentially(thunks: Thunk[]): Promise<void> {
  for (const thunk of thunks) {
    try {
      await thunk();
    } catch {
      /* ignore prefetch failure */
    }
  }
}

/** Prefetch the dashboard chunks the user is most likely to open next, on browser idle. */
export function prefetchDashboardRoutes(role?: string): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const thunks = (role && BY_ROLE[role]) || COMMON_DASHBOARD;
  const run = () => void loadSequentially(thunks);

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 3000 });
  } else {
    window.setTimeout(run, 1500);
  }
}
