import type { Prisma } from '@prisma/client';
import type {
  DomainCommandContext,
  DomainCommandHandler,
} from '../commands';
import type { DomainOwner } from '../domainOwner';

export interface DeleteNotificationForUserInput {
  userId: number;
  notificationId: number;
}

export class NotificationDomain implements DomainOwner {
  readonly ownerName = 'NotificationDomain';

  deleteNotificationForUser(
    input: DeleteNotificationForUserInput,
    context: DomainCommandContext
  ): Promise<Prisma.BatchPayload> {
    return context.tx.notification.deleteMany({
      where: {
        id: input.notificationId,
        userId: input.userId,
      },
    });
  }
}

export const notificationDomain = new NotificationDomain();

export const deleteNotificationForUserCommand: DomainCommandHandler<
  DeleteNotificationForUserInput,
  Prisma.BatchPayload
> = {
  commandName: 'NotificationDomain.DeleteNotificationForUser',
  execute: (input, context) => notificationDomain.deleteNotificationForUser(input, context),
};
