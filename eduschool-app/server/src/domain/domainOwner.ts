import type { DomainCommandContext } from './commands';

export type DomainOwnerName =
  | 'IdentityDomain'
  | 'MembershipDomain'
  | 'SessionDomain'
  | 'AttendanceDomain'
  | 'CreditLedgerDomain'
  | 'AccountingDomain'
  | 'NotificationDomain'
  | 'SchoolPolicyDomain';

export interface DomainOwner {
  readonly ownerName: DomainOwnerName | string;
}

export interface DomainOwnerCommandHandler<TInput = unknown, TOutput = unknown>
  extends DomainOwner {
  readonly commandName: string;
  handle(input: TInput, context: DomainCommandContext): Promise<TOutput>;
}
