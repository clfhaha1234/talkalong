export interface TypedQaTurn {
  role: 'user';
  text: string;
  ts: number;
}

interface PostTypedBranchStartedArgs {
  sessionId: string | null;
  branchId: number;
  fetchImpl?: typeof fetch;
  seam?: (event: string, detail?: string | number) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Typed QA uses Agora sendText() for the answer, but the deterministic narrator
 * still has to enter BRANCH server-side. This tiny contract exists so the cheap
 * eval suite catches "user bubble appears, backend keeps narrating in MAIN".
 */
export function postTypedBranchStarted({
  sessionId,
  branchId,
  fetchImpl = fetch,
  seam,
  warn = console.warn,
}: PostTypedBranchStartedArgs): boolean {
  if (!sessionId) return false;
  seam?.('branch_post', branchId);
  void fetchImpl('/api/tutor/branch-started', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      branch_id: branchId,
      interrupt_audio: false,
    }),
  }).catch((err) => warn('[tutor] /branch-started fetch error', err));
  return true;
}

export function appendTypedTurn(
  prev: Array<{ role: 'user' | 'agent'; text: string; ts: number }>,
  turn: TypedQaTurn,
): Array<{ role: 'user' | 'agent'; text: string; ts: number }> {
  return [...prev, turn].sort((a, b) => a.ts - b.ts);
}
