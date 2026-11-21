import { describe, expect, it } from 'vitest';
import {
  START_BEFORE_COMPLETE_HELPER,
  canSubmitLessonStatus,
  hasLessonStarted,
  isReadOnlyLessonStatus,
  lessonStatusOptionsFor,
  statusTransitionHelper,
} from './sessionStatusUx';

describe('sessionStatusUx', () => {
  it('does not offer completed directly from an upcoming lesson and explains the path', () => {
    const options = lessonStatusOptionsFor('UPCOMING').map(option => option.value);

    expect(options).toEqual(['UPCOMING', 'IN_PROGRESS']);
    expect(options).not.toContain('COMPLETED');
    expect(statusTransitionHelper('UPCOMING')).toBe(START_BEFORE_COMPLETE_HELPER);
  });

  it('allows saving UPCOMING to IN_PROGRESS', () => {
    expect(canSubmitLessonStatus('UPCOMING', 'IN_PROGRESS')).toBe(true);
  });

  it('allows completing only after a lesson is in progress', () => {
    expect(lessonStatusOptionsFor('IN_PROGRESS').map(option => option.value)).toEqual(['IN_PROGRESS', 'COMPLETED']);
    expect(canSubmitLessonStatus('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });

  it('keeps completed lessons read-only', () => {
    expect(isReadOnlyLessonStatus('COMPLETED')).toBe(true);
    expect(lessonStatusOptionsFor('COMPLETED').map(option => option.value)).toEqual(['COMPLETED']);
  });

  it('does not allow forming UPCOMING to COMPLETED on the frontend', () => {
    expect(canSubmitLessonStatus('UPCOMING', 'COMPLETED')).toBe(false);
  });

  describe('hasLessonStarted — mirrors backend hasSessionStarted (whole-day rule)', () => {
    it('allows a lesson today before its start time (whole day is markable)', () => {
      expect(hasLessonStarted('2026-07-03', '2026-07-03', '08:59', '09:00')).toBe(true);
    });

    it('allows a lesson today at its start time', () => {
      expect(hasLessonStarted('2026-07-03', '2026-07-03', '09:00', '09:00')).toBe(true);
    });

    it('allows a lesson today after its start time', () => {
      expect(hasLessonStarted('2026-07-03', '2026-07-03', '09:01', '09:00')).toBe(true);
    });

    it('blocks a future-dated lesson regardless of time-of-day', () => {
      expect(hasLessonStarted('2026-07-04', '2026-07-03', '23:59', '00:00')).toBe(false);
    });

    it('allows a past-dated lesson regardless of time-of-day (deadlock fix)', () => {
      expect(hasLessonStarted('2026-07-02', '2026-07-03', '00:00', '09:00')).toBe(true);
    });
  });
});
