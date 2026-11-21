import { useEffect } from 'react';
import { getSocket } from '../lib/socket';

export interface SessionStatusEvent {
  sessionId: number;
  lessonBlockId: number;
  status: string;
  date: string;
}

export interface AttendanceEvent {
  sessionId: number;
  studentProfileId: number;
  status: string;
}

export interface ScheduleStructureEvent {
  action?: string;
  blockId?: number;
}

export interface ScheduleSessionChangedEvent {
  sessionId: number;
  lessonBlockId?: number;
  date?: string;
  action?: string;
}

interface Handlers {
  onSessionStatusChanged?: (e: SessionStatusEvent) => void;
  onAttendanceUpdated?: (e: AttendanceEvent) => void;
  onStructureChanged?: (e: ScheduleStructureEvent) => void;
  onSessionChanged?: (e: ScheduleSessionChangedEvent) => void;
}

export function useRealtimeSchedule({ onSessionStatusChanged, onAttendanceUpdated, onStructureChanged, onSessionChanged }: Handlers) {
  useEffect(() => {
    const s = getSocket();

    // Register handlers unconditionally — socket.io keeps them across reconnects.
    // The previous early-return on !s.connected prevented handler registration entirely.
    if (onSessionStatusChanged) {
      s.on('session:status-changed', onSessionStatusChanged);
    }
    if (onAttendanceUpdated) {
      s.on('attendance:updated', onAttendanceUpdated);
    }
    if (onStructureChanged) {
      s.on('schedule:structure-changed', onStructureChanged);
    }
    if (onSessionChanged) {
      s.on('schedule:session-changed', onSessionChanged);
    }

    return () => {
      s.off('session:status-changed', onSessionStatusChanged);
      s.off('attendance:updated', onAttendanceUpdated);
      s.off('schedule:structure-changed', onStructureChanged);
      s.off('schedule:session-changed', onSessionChanged);
    };
  }, [onSessionStatusChanged, onAttendanceUpdated, onStructureChanged, onSessionChanged]);
}
