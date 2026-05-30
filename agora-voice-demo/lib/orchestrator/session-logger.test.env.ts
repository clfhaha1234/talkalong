// Sets the session-logger env BEFORE the logger module is imported. ES modules
// are evaluated in import order, and this module is imported (statically) above
// the logger in session-logger.test.ts — so its side effects run first, winning
// the race against the logger's module-load-time env reads.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOG_DIR = mkdtempSync(join(tmpdir(), 'tutor-log-test-'));
process.env.TUTOR_LOG_DIR = LOG_DIR;
process.env.TUTOR_SESSION_LOG = '1';
delete process.env.VERCEL; // ensure the file sink is on
