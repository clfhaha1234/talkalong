import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTypedTurn, postTypedBranchStarted } from './typed-qa-contract';

describe('typed QA contract', () => {
  it('posts branch-started with interrupt_audio=false so typed QA pauses the server narrator', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const seam = vi.fn();

    const posted = postTypedBranchStarted({
      sessionId: 'sess-123',
      branchId: 7,
      fetchImpl,
      seam,
    });

    expect(posted).toBe(true);
    expect(seam).toHaveBeenCalledWith('branch_post', 7);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/tutor/branch-started', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'sess-123',
        branch_id: 7,
        interrupt_audio: false,
      }),
    });
  });

  it('does not POST an unusable null session_id', () => {
    const fetchImpl = vi.fn();

    const posted = postTypedBranchStarted({
      sessionId: null,
      branchId: 1,
      fetchImpl,
    });

    expect(posted).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the typed question visible to the qa-ended timer by returning a fresh ordered transcript', () => {
    const next = appendTypedTurn(
      [{ role: 'agent', text: 'Earlier answer', ts: 300 }],
      { role: 'user', text: 'Hello? Can you hear me?', ts: 200 },
    );

    expect(next).toEqual([
      { role: 'user', text: 'Hello? Can you hear me?', ts: 200 },
      { role: 'agent', text: 'Earlier answer', ts: 300 },
    ]);
  });

  it('TutorPage wires typed submissions through this contract', () => {
    const tutorPagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'TutorPage.tsx');
    const src = readFileSync(tutorPagePath, 'utf8');

    expect(src).toContain("beginVoiceBranch('typed', now, { interruptAudio: false })");
    expect(src).toContain('appendTypedTurn(prev, typedTurn)');
  });
});
