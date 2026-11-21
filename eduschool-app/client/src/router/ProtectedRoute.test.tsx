// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ProtectedRoute } from './index';
import { useAuth } from '../hooks/useAuth';

vi.mock('../hooks/useAuth');
const mockedUseAuth = vi.mocked(useAuth);

function renderProtected(initialPath: string, requiredRoles?: string[]) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path=":slug/login" element={<div>LOGIN_PAGE</div>} />
        <Route path=":slug/onboarding" element={<div>ONBOARDING_PAGE</div>} />
        <Route path=":slug/owner/dashboard" element={<div>OWNER_DASHBOARD</div>} />
        <Route path=":slug/student/dashboard" element={<div>STUDENT_DASHBOARD</div>} />
        <Route
          path=":slug/protected"
          element={
            <ProtectedRoute requiredRoles={requiredRoles}>
              <div>SECRET_CONTENT</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

// Every case below relies on ProtectedRoute reading school.slug === URL slug —
// keep them in sync or the "authenticated" cases fall through to the login redirect.
const school = { id: 1, slug: 'demo', onboardingCompleted: true } as any;

describe('ProtectedRoute', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows a spinner while auth is loading, without leaking protected content', () => {
    mockedUseAuth.mockReturnValue({ user: null, school: null, isLoading: true } as any);
    renderProtected('/demo/protected');
    expect(screen.queryByText('SECRET_CONTENT')).not.toBeInTheDocument();
    expect(screen.queryByText('LOGIN_PAGE')).not.toBeInTheDocument();
  });

  it('redirects to login when there is no authenticated user', () => {
    mockedUseAuth.mockReturnValue({ user: null, school: null, isLoading: false } as any);
    renderProtected('/demo/protected');
    expect(screen.getByText('LOGIN_PAGE')).toBeInTheDocument();
  });

  it('renders protected content for an authenticated user with a matching role', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 1, schoolId: 1, role: 'ADMIN' },
      school,
      isLoading: false,
    } as any);
    renderProtected('/demo/protected', ['ADMIN']);
    expect(screen.getByText('SECRET_CONTENT')).toBeInTheDocument();
  });

  it('redirects to the role-appropriate dashboard when the role does not match', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 1, schoolId: 1, role: 'STUDENT' },
      school,
      isLoading: false,
    } as any);
    renderProtected('/demo/protected', ['OWNER']);
    expect(screen.getByText('STUDENT_DASHBOARD')).toBeInTheDocument();
    expect(screen.queryByText('SECRET_CONTENT')).not.toBeInTheDocument();
  });

  it('force-redirects an OWNER with incomplete onboarding to /onboarding', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 1, schoolId: 1, role: 'OWNER' },
      school: { ...school, onboardingCompleted: false },
      isLoading: false,
    } as any);
    renderProtected('/demo/protected', ['OWNER']);
    expect(screen.getByText('ONBOARDING_PAGE')).toBeInTheDocument();
  });

  it('redirects a fully onboarded OWNER away from /onboarding', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 1, schoolId: 1, role: 'OWNER' },
      school,
      isLoading: false,
    } as any);
    render(
      <MemoryRouter initialEntries={['/demo/onboarding']}>
        <Routes>
          <Route path=":slug/owner/dashboard" element={<div>OWNER_DASHBOARD</div>} />
          <Route
            path=":slug/onboarding"
            element={
              <ProtectedRoute requiredRoles={['OWNER']}>
                <div>ONBOARDING_FORM</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('OWNER_DASHBOARD')).toBeInTheDocument();
  });
});
