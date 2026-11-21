import { Role } from '@prisma/client';

export type Permission =
  | 'schedule:read'
  | 'schedule:write'
  | 'schedule:delete'
  | 'session:write'
  | 'session:lock'
  | 'attendance:write'
  | 'students:read'
  | 'students:write'
  | 'finance:read'
  | 'finance:write'
  | 'finance:void'
  | 'finance:refund'
  | 'salary:read'
  | 'salary:write'
  | 'salary:pay'
  | 'groups:archive'
  | 'data:import'
  | 'settings:read'
  | 'settings:write'
  | 'communications:read'
  | 'communications:write'
  | 'users:read'
  | 'users:manage'
  | 'analytics:read'
  | 'attribution:read'
  | 'attribution:write'
  | 'pixels:read'
  | 'pixels:write'
  | 'webhooks:read'
  | 'webhooks:write'
  | 'integrations:read'
  | 'integrations:write'
  | 'secrets:rotate'
  | 'conflicts:override'
  | 'freeze:write';

const OWNER_INTEGRATION_PERMISSIONS: Permission[] = [
  'attribution:read',
  'attribution:write',
  'pixels:read',
  'pixels:write',
  'webhooks:read',
  'webhooks:write',
  'integrations:read',
  'integrations:write',
  'secrets:rotate',
];

const ADMIN_INTEGRATION_PERMISSIONS: Permission[] = [
  'attribution:read',
  'attribution:write',
  'pixels:read',
  'webhooks:read',
  'integrations:read',
];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPERADMIN: [
    'schedule:read', 'schedule:write', 'schedule:delete',
    'session:write', 'session:lock',
    'attendance:write',
    'students:read', 'students:write',
    'finance:read', 'finance:write', 'finance:void', 'finance:refund',
    'salary:read', 'salary:write', 'salary:pay',
    'groups:archive',
    'data:import',
    'settings:read', 'settings:write',
    'users:read', 'users:manage', 'analytics:read', 'conflicts:override',
    'freeze:write',
    ...OWNER_INTEGRATION_PERMISSIONS,
  ],
  OWNER: [
    'schedule:read', 'schedule:write', 'schedule:delete',
    'session:write', 'session:lock',
    'attendance:write',
    'students:read', 'students:write',
    'finance:read', 'finance:write', 'finance:void', 'finance:refund',
    'salary:read', 'salary:write', 'salary:pay',
    'groups:archive',
    'data:import',
    'settings:read', 'settings:write',
    'communications:read', 'communications:write',
    'users:read', 'users:manage', 'analytics:read', 'conflicts:override',
    'freeze:write',
    ...OWNER_INTEGRATION_PERMISSIONS,
  ],
  ADMIN: [
    'schedule:read', 'schedule:write',
    'session:write',
    'attendance:write',
    'students:read', 'students:write',
    'finance:read',
    'salary:read', 'salary:write',
    'settings:read', 'settings:write',
    'communications:read', 'communications:write',
    'users:read',
    'analytics:read',
    'freeze:write',
    ...ADMIN_INTEGRATION_PERMISSIONS,
  ],
  TEACHER: [
    'schedule:read',
    'session:write',
    'attendance:write',
    'students:read',
  ],
  STUDENT: [
    'schedule:read',
  ],
  PARENT: [
    'schedule:read',
  ],
};

const PERMISSION_SETS = new Map<Role, Set<Permission>>(
  (Object.entries(ROLE_PERMISSIONS) as [Role, Permission[]][]).map(([role, perms]) => [
    role,
    new Set(perms),
  ])
);

export function can(role: Role, permission: Permission): boolean {
  return PERMISSION_SETS.get(role)?.has(permission) ?? false;
}

export function canAny(role: Role, permissions: Permission[]): boolean {
  return permissions.some(p => can(role, p));
}

export function canAll(role: Role, permissions: Permission[]): boolean {
  return permissions.every(p => can(role, p));
}

export function getPermissions(role: Role): Permission[] {
  return Array.from(PERMISSION_SETS.get(role) ?? []);
}
