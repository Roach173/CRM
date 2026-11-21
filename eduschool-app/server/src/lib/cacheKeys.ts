export const CacheKeys = {
  subscription:    (schoolId: number) => `subscription:${schoolId}`,
  schoolSchedule:  (schoolId: number) => `schedule:${schoolId}`,
  weekSessions:    (schoolId: number, week: string) => `sessions:${schoolId}:${week}`,
  teacherCalendar: (schoolId: number, teacherId: number, year: number, month: number) =>
    `teacher-cal:${schoolId}:${teacherId}:${year}:${month}`,
} as const;
