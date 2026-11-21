import { createDomainCommandContext, DomainTransaction } from '../../domain';
import {
  deleteNotificationForUserCommand,
  notificationDomain,
} from '../../domain/notifications';

describe('NotificationDomain', () => {
  it('deletes a notification scoped to the target user through the transaction context', async () => {
    const tx = {
      notification: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as DomainTransaction;
    const context = createDomainCommandContext({
      name: deleteNotificationForUserCommand.commandName,
      actor: { userId: 10, role: 'OWNER', actorType: 'user' },
      schoolId: 1,
      request: { requestId: 'req-123', source: 'test' },
      input: { userId: 10, notificationId: 101 },
    }, tx);

    const result = await notificationDomain.deleteNotificationForUser({
      userId: 10,
      notificationId: 101,
    }, context);

    expect(result).toEqual({ count: 1 });
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({
      where: { id: 101, userId: 10 },
    });
  });
});
