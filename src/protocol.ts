export interface Flag { name: string; takesValue: boolean; optionalValue?: boolean; choices?: string[] }
export interface Catalog {
  cwd: string; commands: string[]; paths: string[]; history: string[];
  functions?: string[];
  historyCwds?: Record<string, string>;
}
export interface Candidate { command: string; score: number; changes: string[]; literal?: boolean }
export interface ShellState {
  cwd: string; inputRevision: number; promptRevision: number; ready: boolean; prompt: number; exited: boolean; exitCode?: number;
}
export type ServerMessage =
  | { type: 'output'; seq: number; data: string }
  | { type: 'state'; state: ShellState }
  | { type: 'hello'; reset: boolean; truncated: boolean; firstSeq: number }
  | { type: 'edit-result'; id: string; accepted: boolean; revision: number }
  | { type: 'result'; id: string; accepted: boolean; message?: string };
export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'replace'; text: string; id: string; prompt: number; revision: number }
  | { type: 'command'; command: string; id: string; prompt: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; seq: number };
