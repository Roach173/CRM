import { Router } from 'express';
import { extendAllBlockSessions } from '../../services/sessionService';
import blocksRoutes from './scheduleBlocks.routes';
import groupPairRoutes from './scheduleGroupPair.routes';
import enrollmentRoutes from './scheduleEnrollment.routes';
import availabilityRoutes from './scheduleAvailability.routes';
import sessionsRoutes from './scheduleSessions.routes';
import attendanceRoutes from './scheduleAttendance.routes';
import policyRoutes from './schedulePolicy.routes';
import dashboardRoutes from './scheduleDashboard.routes';
import integrityRoutes from './scheduleIntegrity.routes';

const router = Router();

router.use(blocksRoutes);
router.use(policyRoutes);
router.use(groupPairRoutes);
router.use(enrollmentRoutes);
router.use(availabilityRoutes);
router.use(sessionsRoutes);
router.use(attendanceRoutes);
router.use(dashboardRoutes);
router.use(integrityRoutes);

export { extendAllBlockSessions };
export { resolveWritableTimeSlot } from './scheduleRouteUtils';

export default router;
