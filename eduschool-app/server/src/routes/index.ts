import { Router } from 'express';
import adminRoutes from './admin';
import authRoutes from './auth';
import usersRoutes from './users';
import studentsRoutes from './students';
import scheduleRoutes from './schedule';
import groupsRoutes from './groups';
import salaryRoutes from './salary';
import creditsRoutes from './credits';
import analyticsRoutes from './analytics';
import schoolsRoutes from './schools';
import settingsRoutes from './settings';
import superadminRoutes from './superadmin';
import subscriptionsRoutes from './subscriptions';
import subscriptionRoutes from './subscription';
import invitesRoutes from './invites';
import notificationsRoutes from './notifications';
import twoFaRoutes from './2fa';
import onboardingRoutes from './onboarding';
import importExportRoutes from './importexport';
import exceptionsRoutes from './exceptions';
import uploadRoutes from './upload';
import parentRoutes from './parent';
import invoicesRoutes from './invoices';
import paymentsRoutes from './payments';
import receivablesRoutes from './receivables';
import communicationsRoutes from './communications';
import publicRoutes from './public';
import freezeRoutes from './freeze';
import calendarNotesRoutes from './calendarNotes';
import {
  attendanceLimiter,
  sessionEnsureLimiter,
  notificationsLimiter,
  creditsLimiter,
  generalLimiter,
} from '../middleware/rateLimiters';
import { authenticate } from '../middleware/authenticate';
import { subscriptionGuard } from '../middleware/subscriptionGuard';

const router = Router();

router.use('/admin', authenticate, subscriptionGuard, adminRoutes);
router.use('/superadmin', superadminRoutes);
router.use('/subscriptions', subscriptionsRoutes); // intentionally public: Paddle webhook receiver
router.use('/subscription', subscriptionRoutes);
router.use('/notifications', notificationsLimiter, authenticate, subscriptionGuard, notificationsRoutes);
router.use('/schools', schoolsRoutes);
router.use('/settings', authenticate, subscriptionGuard, settingsRoutes);
router.use('/2fa', twoFaRoutes);
router.use('/onboarding', onboardingRoutes);

router.use('/auth', authRoutes);
router.use('/students', authenticate, subscriptionGuard, studentsRoutes);
router.use('/schedule', authenticate, subscriptionGuard, scheduleRoutes);
router.use('/groups', authenticate, subscriptionGuard, groupsRoutes);
router.use('/salary', authenticate, subscriptionGuard, salaryRoutes);
router.use('/credits', creditsLimiter, authenticate, subscriptionGuard, creditsRoutes);
router.use('/analytics', authenticate, subscriptionGuard, analyticsRoutes);
router.use('/stats', authenticate, subscriptionGuard, analyticsRoutes);
router.use('/users', authenticate, subscriptionGuard, usersRoutes);
router.use('/invites', invitesRoutes); // intentionally public: invite accept links are token-gated inside the route
router.use('/import-export', authenticate, subscriptionGuard, importExportRoutes);
router.use('/exceptions', authenticate, subscriptionGuard, exceptionsRoutes);
router.use('/upload', authenticate, subscriptionGuard, uploadRoutes);
router.use('/parent', authenticate, subscriptionGuard, parentRoutes);
router.use('/invoices', authenticate, subscriptionGuard, invoicesRoutes);
router.use('/payments', authenticate, subscriptionGuard, paymentsRoutes);
router.use('/receivables', authenticate, subscriptionGuard, receivablesRoutes);
router.use('/communications', authenticate, subscriptionGuard, communicationsRoutes);
router.use('/public', publicRoutes); // intentionally public: school info for enrollment forms (no auth)
router.use('/freeze', authenticate, subscriptionGuard, freezeRoutes);
router.use('/calendar-notes', authenticate, subscriptionGuard, calendarNotesRoutes);

// Attendance и session/ensure имеют отдельные лимиты — применяются внутри schedule.ts
export { attendanceLimiter, sessionEnsureLimiter, generalLimiter };

export default router;
