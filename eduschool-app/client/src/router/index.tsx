import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, Outlet, useLocation } from 'react-router';
import { ScrollToTop } from '../components/ScrollToTop';
import { useAuth } from '../hooks/useAuth';
import { AppErrorBoundary } from '../components/ui/ErrorBoundary';

// Eager — critical path, no lazy
import Login from '../pages/Login';
import RegisterSchool from '../pages/RegisterSchool';
import SchoolLanding from '../pages/SchoolLanding';
import NotFound from '../pages/NotFound';
import Terms from '../pages/Terms';
import Privacy from '../pages/Privacy';
import Layout from '../components/layout/Layout';

// Lazy — marketing landing (only route: /business-card). Sole consumer of framer-motion/gsap/lenis,
// so lazy-loading keeps those heavy animation libs out of the main entry chunk for dashboard users.
const Landing = React.lazy(() => import('../pages/Landing'));

// Lazy — auth flows (small but rarely hit)
const TwoFactorChallenge = React.lazy(() => import('../pages/auth/TwoFactorChallenge'));
const TwoFactorSetup     = React.lazy(() => import('../pages/settings/TwoFactorSetup'));
const NotificationPreferences = React.lazy(() => import('../pages/settings/NotificationPreferences'));
const VerifyEmail        = React.lazy(() => import('../pages/auth/VerifyEmail'));
const ForgotPassword     = React.lazy(() => import('../pages/auth/ForgotPassword'));
const ResetPassword      = React.lazy(() => import('../pages/auth/ResetPassword'));
const AcceptInvite       = React.lazy(() => import('../pages/auth/AcceptInvite'));

// Lazy — shared/utility pages
const Help    = React.lazy(() => import('../pages/Help'));
const Profile = React.lazy(() => import('../pages/Profile'));
const NotificationsInbox = React.lazy(() => import('../pages/dashboard/NotificationsInbox'));

// Lazy — admin/owner pages (heavy: schedule, salary, import-export, recharts)
const CommunicationsPage = React.lazy(() => import('../pages/dashboard/communications/CommunicationsPage'));
const AdminStudents    = React.lazy(() => import('../pages/dashboard/admin/Students'));
const AdminAttendance  = React.lazy(() => import('../pages/dashboard/admin/Attendance'));
const AdminSchedule    = React.lazy(() => import('../pages/dashboard/admin/Schedule'));
const AdminTeachers    = React.lazy(() => import('../pages/dashboard/admin/Teachers'));
const AdminGroups      = React.lazy(() => import('../pages/dashboard/admin/Groups'));
const AdminGroupDetail = React.lazy(() => import('../pages/dashboard/admin/GroupDetail'));
const AdminSettings    = React.lazy(() => import('../pages/dashboard/admin/Settings'));
const AdminSalary      = React.lazy(() => import('../pages/dashboard/admin/Salary'));
const AdminSalaryPayslip = React.lazy(() => import('../pages/dashboard/admin/SalaryPayslip'));
const AdminSalaryHistory = React.lazy(() => import('../pages/dashboard/admin/SalaryHistory'));
const AdminCrmSettings = React.lazy(() => import('../pages/dashboard/admin/CrmSettings'));
const AdminImportExport = React.lazy(() => import('../pages/dashboard/admin/ImportExport'));
const FinanceDashboard = React.lazy(() => import('../pages/dashboard/admin/FinanceDashboard'));
// Lazy — owner pages
// ponytail: "Панель управления" (Overview) hidden per request — restore this + the dashboard route to bring it back
// const OwnerOverview  = React.lazy(() => import('../pages/dashboard/owner/Overview'));
const OwnerStaff     = React.lazy(() => import('../pages/dashboard/owner/Staff'));
const OwnerFinanceControl = React.lazy(() => import('../pages/dashboard/owner/FinanceControl'));
const OwnerOnboarding = React.lazy(() => import('../pages/OwnerOnboarding'));

// Lazy — teacher pages
const TeacherSchedule = React.lazy(() => import('../pages/dashboard/teacher/TeacherSchedule'));
const TeacherSalary   = React.lazy(() => import('../pages/dashboard/teacher/TeacherSalary'));

// Lazy — student pages
const StudentOverview    = React.lazy(() => import('../pages/dashboard/student/Overview'));
const StudentSchedule    = React.lazy(() => import('../pages/dashboard/student/Schedule'));

// Lazy — superadmin pages
const SuperAdminDashboard = React.lazy(() => import('../pages/dashboard/superadmin/Dashboard'));
const SuperAdminSchools   = React.lazy(() => import('../pages/dashboard/superadmin/Schools'));
const SuperAdminSettings  = React.lazy(() => import('../pages/dashboard/superadmin/Settings'));

// Lazy — parent pages
const ParentDashboard = React.lazy(() => import('../pages/dashboard/parent/ParentDashboard'));

const PageSpinner = () => (
  <div className="min-h-screen flex items-center justify-center bg-background">
    <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
  </div>
);

export function ProtectedRoute({ children, requiredRoles }: { children?: React.ReactNode; requiredRoles?: string[] }) {
  const { user, school, isLoading } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();

  if (isLoading) {
    return <PageSpinner />;
  }

  const savedSlug = school?.slug || localStorage.getItem('schoolSlug');
  if (!user || user.schoolId !== school?.id || savedSlug !== slug) {
    return <Navigate to={`/${slug || savedSlug || ''}/login`} replace />;
  }

  const isOnboardingPath = location.pathname === `/${slug}/onboarding`;

  // 1. If incomplete OWNER, force-redirect them to /onboarding
  if (user.role === 'OWNER' && !school?.onboardingCompleted) {
    if (!isOnboardingPath) {
      return <Navigate to={`/${slug}/onboarding`} replace />;
    }
  }

  // 2. If completed OWNER, prevent them from accessing /onboarding
  if (user.role === 'OWNER' && school?.onboardingCompleted && isOnboardingPath) {
    return <Navigate to={`/${slug}/owner/dashboard`} replace />;
  }

  // 3. For other roles (ADMIN, TEACHER, STUDENT, PARENT), prevent accessing /onboarding
  if (user.role !== 'OWNER' && isOnboardingPath) {
    const fallbackPrefix = user.role === 'TEACHER' ? 'teacher/schedule' : `${user.role.toLowerCase()}/dashboard`;
    return <Navigate to={`/${slug}/${fallbackPrefix}`} replace />;
  }

  // 4. Standard role guard
  if (requiredRoles && !requiredRoles.includes(user.role)) {
    const fallbackPrefix = user.role === 'TEACHER' ? 'teacher/schedule' : `${user.role.toLowerCase()}/dashboard`;
    return <Navigate to={`/${slug}/${fallbackPrefix}`} replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/business-card" element={<Landing />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/register" element={<RegisterSchool />} />
          <Route path="/login" element={<Login />} />
          <Route path="/auth/2fa" element={<TwoFactorChallenge />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/invite" element={<AcceptInvite />} />

          {/* Super Admin */}
          <Route path="/superadmin/login" element={<Login />} />
          <Route path="/superadmin/dashboard" element={<AppErrorBoundary><SuperAdminDashboard /></AppErrorBoundary>} />
          <Route path="/superadmin/schools"   element={<AppErrorBoundary><SuperAdminSchools /></AppErrorBoundary>} />
          <Route path="/superadmin/settings"  element={<AppErrorBoundary><SuperAdminSettings /></AppErrorBoundary>} />

          <Route path="/:slug">
            <Route index element={<SchoolLanding />} />
            <Route path="login" element={<Login />} />
            <Route path="onboarding" element={<ProtectedRoute requiredRoles={['OWNER']}><OwnerOnboarding /></ProtectedRoute>} />

            <Route element={<Layout />}>

              {/* Owner */}
              <Route path="owner" element={<AppErrorBoundary><ProtectedRoute requiredRoles={['OWNER']} /></AppErrorBoundary>}>
                <Route index element={<Navigate to="students" replace />} />
                {/* ponytail: "Панель управления" (Overview) hidden per request — dashboard redirects to students */}
                <Route path="dashboard"       element={<Navigate to="../students" replace />} />
                <Route path="notifications"   element={<NotificationsInbox />} />
                <Route path="communications"  element={<CommunicationsPage />} />
                <Route path="broadcast"       element={<Navigate to="../communications" replace />} />
                <Route path="students"        element={<AdminStudents />} />
                <Route path="attendance"      element={<AdminAttendance />} />
                <Route path="schedule"        element={<AdminSchedule />} />
                <Route path="groups"          element={<AdminGroups />} />
                <Route path="groups/:groupId" element={<AdminGroupDetail />} />
                <Route path="salary"          element={<AdminSalary />} />
                <Route path="salary/:staffId/history" element={<AdminSalaryHistory />} />
                <Route path="salary/:staffId" element={<AdminSalaryPayslip />} />
                <Route path="finance"         element={<FinanceDashboard />} />
                <Route path="finance-dashboard" element={<FinanceDashboard />} />
                <Route path="finance-control" element={<OwnerFinanceControl />} />
                <Route path="design"          element={<AdminSettings />} />
                <Route path="settings"        element={<AdminCrmSettings />} />
                <Route path="import-export"   element={<AdminImportExport />} />
                <Route path="staff"           element={<OwnerStaff />} />
              </Route>

              {/* Admin */}
              <Route path="admin" element={<AppErrorBoundary><ProtectedRoute requiredRoles={['ADMIN']} /></AppErrorBoundary>}>
                <Route index element={<Navigate to="students" replace />} />
                <Route path="dashboard"       element={<Navigate to="../students" replace />} />
                <Route path="notifications"   element={<NotificationsInbox />} />
                <Route path="communications"  element={<CommunicationsPage />} />
                <Route path="broadcast"       element={<Navigate to="../communications" replace />} />
                <Route path="students"        element={<AdminStudents />} />
                <Route path="attendance"      element={<AdminAttendance />} />
                <Route path="schedule"        element={<AdminSchedule />} />
                <Route path="groups"          element={<AdminGroups />} />
                <Route path="groups/:groupId" element={<AdminGroupDetail />} />
                <Route path="teachers"        element={<AdminTeachers />} />
                <Route path="salary"          element={<AdminSalary />} />
                <Route path="salary/:staffId/history" element={<AdminSalaryHistory />} />
                <Route path="salary/:staffId" element={<AdminSalaryPayslip />} />
                <Route path="finance"         element={<FinanceDashboard />} />
                <Route path="finance-dashboard" element={<FinanceDashboard />} />
                <Route path="design"          element={<AdminSettings />} />
                <Route path="settings"        element={<AdminCrmSettings />} />
                <Route path="import-export"   element={<AdminImportExport />} />
              </Route>

              {/* Teacher */}
              <Route path="teacher" element={<AppErrorBoundary><ProtectedRoute requiredRoles={['TEACHER']} /></AppErrorBoundary>}>
                <Route index element={<Navigate to="schedule" replace />} />
                <Route path="dashboard"     element={<Navigate to="../schedule" replace />} />
                <Route path="schedule"      element={<TeacherSchedule />} />
                <Route path="notifications" element={<NotificationsInbox />} />
                <Route path="salary"        element={<TeacherSalary />} />
              </Route>

              {/* Student */}
              <Route path="student" element={<AppErrorBoundary><ProtectedRoute requiredRoles={['STUDENT']} /></AppErrorBoundary>}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard"  element={<StudentOverview />} />
                <Route path="notifications" element={<NotificationsInbox />} />
                <Route path="schedule"   element={<StudentSchedule />} />
              </Route>

              {/* Parent */}
              <Route path="parent" element={<AppErrorBoundary><ProtectedRoute requiredRoles={['PARENT']} /></AppErrorBoundary>}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard"     element={<ParentDashboard />} />
                <Route path="notifications" element={<NotificationsInbox />} />
              </Route>

              {/* Shared protected */}
              <Route path="help"       element={<ProtectedRoute><Help /></ProtectedRoute>} />
              <Route path="profile"    element={<ProtectedRoute><Profile /></ProtectedRoute>} />
              <Route path="settings/notifications" element={<ProtectedRoute><NotificationPreferences /></ProtectedRoute>} />
              <Route path="settings/2fa" element={<ProtectedRoute><TwoFactorSetup /></ProtectedRoute>} />

            </Route>
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
