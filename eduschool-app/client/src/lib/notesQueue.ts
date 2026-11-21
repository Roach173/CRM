// Offline retry queue for student notes. When a note save fails while offline,
// it's stashed in localStorage and flushed on the next `online` event (and on load).
// ponytail: single-field localStorage queue; if more fields ever need offline writes,
// promote to a generic outbox keyed by endpoint.
import api from './api';

const KEY = 'pendingStudentNotes';

type Queue = Record<string, string>; // studentId -> notes

function read(): Queue {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function write(q: Queue) {
  localStorage.setItem(KEY, JSON.stringify(q));
}

export function queueNote(studentId: number, notes: string) {
  const q = read();
  q[String(studentId)] = notes;
  write(q);
}

// Drop a queued note once it has been saved directly (avoids a stale offline
// copy later overwriting a newer online edit).
export function clearQueuedNote(studentId: number) {
  const q = read();
  if (q[String(studentId)] === undefined) return;
  delete q[String(studentId)];
  write(q);
}

export async function flushNotes() {
  const q = read();
  for (const id of Object.keys(q)) {
    try {
      await api.patch(`/students/${id}`, { notes: q[id] });
      delete q[id];
      write(q);
    } catch {
      break; // still offline / server down — keep the rest queued, retry next event
    }
  }
}

window.addEventListener('online', flushNotes);
flushNotes(); // catch anything left from a previous session
