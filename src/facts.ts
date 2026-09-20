import type { Catalog, Flag } from './protocol.ts';
import type { Help } from './engine/help.ts';
import type { DirectoryEntry, FileInfo, DirectoryLookup } from './directory-data.ts';

export type Fact =
  | { kind: 'stat'; path: string }
  | { kind: 'lookup'; path: string }
  | { kind: 'entries'; path: string; limit: number }
  | { kind: 'syntax'; command: string }
  | { kind: 'help'; command: string; route: string[] }
  | { kind: 'describe'; command: string };
export type FactValue = DirectoryLookup | FileInfo | DirectoryEntry[] | boolean | Help | Flag[] | null;
export interface Snapshot { key: string; catalogKey: string; catalog: Catalog; home: string; discoveryKey: string }
export interface ContextReply extends Omit<Snapshot, 'catalog'> { catalog?: Catalog }
