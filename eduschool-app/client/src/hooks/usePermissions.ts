import { useAuth } from './useAuth';

export interface Permissions {
  canEditSchoolSettings: boolean;
  canClearData: boolean;
  canPaySalary: boolean;
  canManageStaff: boolean;
  canEditRate: boolean;
  canImport: boolean;
  canArchiveGroup: boolean;
  canDeleteSchedule: boolean;
  canWriteFinance: boolean;
  canReadAttribution: boolean;
  canWriteAttribution: boolean;
  canReadPixels: boolean;
  canWritePixels: boolean;
  canReadWebhooks: boolean;
  canWriteWebhooks: boolean;
  canReadIntegrations: boolean;
  canWriteIntegrations: boolean;
  canRotateSecrets: boolean;
}

export function usePermissions(): Permissions {
  const { user } = useAuth();
  const isOwner = user?.role === 'OWNER';
  const isSuperadmin = user?.role === 'SUPERADMIN';
  const isAdmin = user?.role === 'ADMIN';
  const hasFullPermissions = isOwner || isSuperadmin;

  return {
    canEditSchoolSettings: isOwner,
    canClearData: isOwner,
    canPaySalary: hasFullPermissions,
    canManageStaff: hasFullPermissions,
    canEditRate: isOwner,
    canImport: hasFullPermissions,
    canArchiveGroup: hasFullPermissions,
    canDeleteSchedule: hasFullPermissions,
    canWriteFinance: hasFullPermissions,
    canReadAttribution: hasFullPermissions || isAdmin,
    canWriteAttribution: hasFullPermissions || isAdmin,
    canReadPixels: hasFullPermissions || isAdmin,
    canWritePixels: hasFullPermissions,
    canReadWebhooks: hasFullPermissions || isAdmin,
    canWriteWebhooks: hasFullPermissions,
    canReadIntegrations: hasFullPermissions || isAdmin,
    canWriteIntegrations: hasFullPermissions,
    canRotateSecrets: hasFullPermissions,
  };
}
