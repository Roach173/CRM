import { Router } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/authenticate';

// Shared admin day-notes for the schedule calendar.
// School-scoped: one note per (school, date), visible to everyone in the school,
// editable by OWNER/ADMIN. Adapted from the per-user roach07 calendar-notes feature.
const router = Router();
const MAX_NOTE_LENGTH = 2000;

const isAdmin = (role?: string) => role === 'OWNER' || role === 'ADMIN';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Personal per-user notes (student calendar). Any authenticated user manages only their own. ───

// GET /calendar-notes/me — caller's personal notes
router.get('/me', async (req: AuthRequest, res) => {
  try {
    const { userId } = req.user!;
    const notes = await prisma.studentCalendarNote.findMany({
      where: { userId },
      select: { date: true, content: true },
      orderBy: { date: 'asc' },
    });
    res.json({
      success: true,
      data: notes.map(n => ({ date: n.date.toISOString().slice(0, 10), content: n.content })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT /calendar-notes/me/:date — upsert (or delete when empty) caller's own note
router.put('/me/:date', async (req: AuthRequest, res) => {
  try {
    const { userId, schoolId } = req.user!;
    const { date } = req.params;
    const { content } = req.body as { content?: string };

    if (!DATE_RE.test(date)) {
      res.status(400).json({ success: false, message: 'Invalid date format' });
      return;
    }
    if (content && content.length > MAX_NOTE_LENGTH) {
      res.status(400).json({ success: false, message: `Заметка не может быть длиннее ${MAX_NOTE_LENGTH} символов` });
      return;
    }

    const dateObj = new Date(`${date}T00:00:00.000Z`);

    if (!content || !content.trim()) {
      await prisma.studentCalendarNote.deleteMany({ where: { userId, date: dateObj } });
      res.json({ success: true, deleted: true });
      return;
    }

    const note = await prisma.studentCalendarNote.upsert({
      where: { userId_date: { userId, date: dateObj } },
      create: { userId, schoolId, date: dateObj, content: content.trim() },
      update: { content: content.trim() },
      select: { date: true, content: true },
    });
    res.json({ success: true, data: { date: note.date.toISOString().slice(0, 10), content: note.content } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /calendar-notes — all notes for the caller's school. OWNER/ADMIN only (admin-shared notes).
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { schoolId, role } = req.user!;
    if (!isAdmin(role)) {
      res.status(403).json({ success: false, message: 'Только OWNER/ADMIN' });
      return;
    }
    const notes = await prisma.calendarNote.findMany({
      where: { schoolId },
      select: { date: true, content: true },
      orderBy: { date: 'asc' },
    });
    const data = notes.map(n => ({
      date: n.date.toISOString().slice(0, 10),
      content: n.content,
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT /calendar-notes/:date — upsert (or delete when content is empty). OWNER/ADMIN only.
router.put('/:date', async (req: AuthRequest, res) => {
  try {
    const { userId, schoolId, role } = req.user!;
    if (!isAdmin(role)) {
      res.status(403).json({ success: false, message: 'Только OWNER/ADMIN могут менять заметки календаря' });
      return;
    }

    const { date } = req.params;
    const { content } = req.body as { content?: string };

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ success: false, message: 'Invalid date format' });
      return;
    }
    if (content && content.length > MAX_NOTE_LENGTH) {
      res.status(400).json({ success: false, message: `Заметка не может быть длиннее ${MAX_NOTE_LENGTH} символов` });
      return;
    }

    const dateObj = new Date(`${date}T00:00:00.000Z`);

    if (!content || !content.trim()) {
      await prisma.calendarNote.deleteMany({ where: { schoolId, date: dateObj } });
      res.json({ success: true, deleted: true });
      return;
    }

    const note = await prisma.calendarNote.upsert({
      where: { schoolId_date: { schoolId, date: dateObj } },
      create: { schoolId, date: dateObj, content: content.trim(), authorId: userId },
      update: { content: content.trim(), authorId: userId },
      select: { date: true, content: true },
    });

    res.json({
      success: true,
      data: { date: note.date.toISOString().slice(0, 10), content: note.content },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
