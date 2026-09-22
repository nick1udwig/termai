export interface Flag { name: string; takesValue: boolean; optionalValue?: boolean }
export interface Catalog {
  cwd: string; commands: string[]; paths: string[]; history: string[];
  functions?: string[];
  historyCwds?: Record<string, string>;
}
export interface Candidate { command: string; score: number; changes: string[]; literal?: boolean }
