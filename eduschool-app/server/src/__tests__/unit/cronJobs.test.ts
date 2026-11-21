describe('cron job scheduler helpers', () => {
  it('calculates a positive delay for the next daily run', async () => {
    const { calculateNextDailyRunDelay } = await import('../../lib/cronJobs');

    const delay = calculateNextDailyRunDelay(3, 0, new Date(2026, 5, 4, 1, 0, 0, 0));

    expect(delay).toBeGreaterThan(0);
  });

  it('schedules today when current time is before the target time', async () => {
    const { calculateNextDailyRunDelay } = await import('../../lib/cronJobs');

    const delay = calculateNextDailyRunDelay(3, 0, new Date(2026, 5, 4, 1, 30, 0, 0));

    expect(delay).toBe(90 * 60 * 1000);
  });

  it('schedules tomorrow when current time is after the target time', async () => {
    const { calculateNextDailyRunDelay } = await import('../../lib/cronJobs');

    const delay = calculateNextDailyRunDelay(3, 0, new Date(2026, 5, 4, 4, 0, 0, 0));

    expect(delay).toBe(23 * 60 * 60 * 1000);
  });
});
