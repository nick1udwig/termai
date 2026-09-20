import type { ContextReply } from './facts.ts';
import type { DirectorySnapshot } from './directory-data.ts';
export type EngineMode = 'server' | 'client';
export type { Flag, Catalog, Candidate } from './engine/types.ts';
export interface ShellState {
  cwd: string; inputRevision: number; promptRevision: number; ready: boolean; prompt: number; exited: boolean; exitCode?: number;
}
export type ServerMessage =
  | { type: 'output'; seq: number; data: string }
  | { type: 'state'; state: ShellState }
  | { type: 'context'; context: ContextReply; directories: { path: string; snapshot: DirectorySnapshot }[] }
  | { type: 'hello'; engine: EngineMode; reset: boolean; truncated: boolean; firstSeq: number }
  | { type: 'edit-result'; id: string; accepted: boolean; revision: number }
  | { type: 'result'; id: string; accepted: boolean; message?: string };
export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'replace'; text: string; id: string; prompt: number; revision: number }
  | { type: 'command'; command: string; id: string; prompt: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; seq: number };
