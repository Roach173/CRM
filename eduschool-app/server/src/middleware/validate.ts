import { Request, Response, NextFunction } from 'express';
import { ZodType } from 'zod';

// Parses req.body against `schema`; on success replaces req.body with the
// parsed (typed, coerced) value so handlers don't re-validate downstream.
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error.issues[0]?.message ?? 'Invalid request body',
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
