export interface DeliverSegment { id: string; kind: 'deliver'; text: string; load_bearing?: boolean; }
export interface ElicitSegment { id: string; kind: 'elicit'; question: string; target: string; load_bearing?: boolean; }
export type AgendaSegment = DeliverSegment | ElicitSegment;
export interface Agenda { id: string; title: string; segments: AgendaSegment[]; }

export const isElicit = (s: AgendaSegment): s is ElicitSegment => s.kind === 'elicit';

// Injected I/O — the same engine runs offline (mock) or on Agora (later).
export interface Actuator { speak(text: string, opts?: { interrupt?: boolean }): Promise<void>; }
export type UserTurn = { kind: 'text'; text: string } | { kind: 'silence' };
export interface Listener { nextUserTurn(): Promise<UserTurn>; }

export interface PolicyFlags { elicitation_enabled: boolean; language: string; style: string | null; }
export interface TranscriptEntry { role: 'agent' | 'user' | 'system'; text: string; segment_id?: string; meta?: Record<string, unknown>; }
