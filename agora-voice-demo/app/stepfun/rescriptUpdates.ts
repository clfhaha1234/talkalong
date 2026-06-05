export interface StepFunRescriptScene {
  id: string;
  narration: string;
  audioDataUrl: string;
}

export interface StepFunSceneForRescript {
  id: string;
  narration: string;
  audioDataUrl: string;
}

export function hasUsableAudioDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:audio/') && value.length > 128;
}

export function applyRescriptUpdates<T extends StepFunSceneForRescript>(
  scenes: T[],
  updates: StepFunRescriptScene[],
): T[] | null {
  if (!updates.length) return null;

  const byId = new Map(updates.map((s) => [s.id, s]));
  for (const upd of updates) {
    if (typeof upd.narration !== 'string' || upd.narration.trim().length < 8) return null;
    if (!hasUsableAudioDataUrl(upd.audioDataUrl)) return null;
  }

  let touched = false;
  const next = scenes.map((scene) => {
    const upd = byId.get(scene.id);
    if (!upd) return scene;
    touched = true;
    return {
      ...scene,
      narration: upd.narration,
      audioDataUrl: upd.audioDataUrl,
    };
  });

  return touched ? next : null;
}
