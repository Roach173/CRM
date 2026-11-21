import { CommunicationChannel, CommunicationTargetType, Role } from '@prisma/client';

export const ALLOWED_COMMUNICATION_TARGET_TYPES = [
  CommunicationTargetType.ROLES,
  CommunicationTargetType.USERS,
  CommunicationTargetType.GROUPS,
] as const;

export const COMMUNICATION_GROUP_AUDIENCES = [
  'STUDENTS',
  'PARENTS',
  'STUDENTS_AND_PARENTS',
] as const;

export type CommunicationGroupAudience = (typeof COMMUNICATION_GROUP_AUDIENCES)[number];

export const ALLOWED_COMMUNICATION_RECIPIENT_ROLES = [
  Role.OWNER,
  Role.ADMIN,
  Role.TEACHER,
  Role.STUDENT,
  Role.PARENT,
] as const;

export const DEFAULT_COMMUNICATION_CHANNEL = CommunicationChannel.IN_APP;
export const COMMUNICATION_NOTIFICATION_TYPE = 'ANNOUNCEMENT';
export const COMMUNICATION_ENTITY_TYPE = 'CommunicationCampaign';
export const COMMUNICATION_SKIP_REASON = {
  PREFERENCE_DISABLED: 'PREFERENCE_DISABLED',
} as const;

const RECIPIENT_ROLE_SET = new Set<Role>(ALLOWED_COMMUNICATION_RECIPIENT_ROLES);
const GROUP_AUDIENCE_SET = new Set<string>(COMMUNICATION_GROUP_AUDIENCES);

export function isAllowedCommunicationRecipientRole(role: Role): boolean {
  return RECIPIENT_ROLE_SET.has(role);
}

export function isAllowedCommunicationGroupAudience(audience: unknown): audience is CommunicationGroupAudience {
  return typeof audience === 'string' && GROUP_AUDIENCE_SET.has(audience);
}
