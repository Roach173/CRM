import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Role } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { uploadLimiter } from '../middleware/rateLimiters';
import { createLogger } from '../lib/logger';

const log = createLogger('upload');
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB hard cap
});

const uploadDir = path.join(process.cwd(), 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * Validates image file via magic bytes.
 * SVG is checked first (text-based format, can embed scripts) before any binary checks.
 * Sharp will also reject any file whose bytes don't match a supported image format —
 * this is a defense-in-depth pre-check to give an explicit error before reaching sharp.
 */
function validateImageMagicBytes(buffer: Buffer): { valid: boolean; reason?: string } {
  if (buffer.length < 12) return { valid: false, reason: 'File too small to be a valid image' };

  // SVG / XML detection — must be rejected before sharp processes anything
  // SVG can contain embedded JavaScript, event handlers, and external resource references
  const head = buffer.slice(0, 512).toString('latin1').trimStart();
  if (head.startsWith('<') || head.startsWith('\xef\xbb\xbf<')) {
    return { valid: false, reason: 'SVG and XML files are not allowed' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return { valid: true };
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return { valid: true };
  // GIF: 47 49 46 38 (GIF8)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return { valid: true };
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return { valid: true };
  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) return { valid: true };
  // TIFF: II*\0 (little-endian) or MM\0* (big-endian)
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) ||
    (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A)
  ) return { valid: true };

  return { valid: false, reason: 'Unsupported or unrecognised image format' };
}

router.post('/', authenticate, uploadLimiter, upload.single('image'), async (req: AuthRequest, res: any) => {
  try {
    // Phase 6 policy: uploads are OWNER-only (landing page images for school branding)
    // SUPERADMIN can also upload for platform-level operations
    const role = req.user!.role;
    if (role !== Role.OWNER && role !== Role.SUPERADMIN) {
      log.warn({ userId: req.user!.userId, role }, 'upload rejected: insufficient role');
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }

    const check = validateImageMagicBytes(req.file.buffer);
    if (!check.valid) {
      log.warn(
        { schoolId: req.user!.schoolId, userId: req.user!.userId, reason: check.reason, size: req.file.size, mimetype: req.file.mimetype },
        'upload rejected: invalid image magic bytes',
      );
      return res.status(400).json({ success: false, error: check.reason ?? 'Invalid file type' });
    }

    // Storage path scoped to schoolId — prevents cross-tenant path guessing
    const schoolId = req.user!.schoolId!;
    const schoolDir = path.join(uploadDir, String(schoolId));
    if (!fs.existsSync(schoolDir)) {
      fs.mkdirSync(schoolDir, { recursive: true });
    }

    const filename = `${uuidv4()}.webp`;
    const outputPath = path.join(schoolDir, filename);

    // Sharp validates the actual image format when processing — any polyglot that passed
    // magic byte checks will fail here if it is not a valid image.
    await sharp(req.file.buffer)
      .webp({ quality: 80 })
      .toFile(outputPath);

    const fileUrl = `/uploads/${schoolId}/${filename}`;
    res.json({ success: true, data: { url: fileUrl } });
  } catch (error) {
    log.error({ err: error }, 'upload error');
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

export default router;
