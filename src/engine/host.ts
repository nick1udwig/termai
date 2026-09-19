import type { Catalog, Flag } from '../protocol.ts';
import type { CommandMetadata } from './command-policy.ts';

export type Environment = Record<string, string | undefined>;
export interface FileInfo { file: boolean; directory: boolean; executable: boolean }
export interface DirectoryEntry { name: string; directory: boolean; symlink: boolean }
/** All host dependencies of the repair engine. No terminal writes or general exec. */
export interface EngineHost {
  stat(path: string, signal?: AbortSignal): Promise<FileInfo | undefined>;
  entries(path: string, limit: number, signal?: AbortSignal): Promise<DirectoryEntry[]>;
  syntax(command: string, signal: AbortSignal): Promise<boolean>;
}
export interface MetadataDiscovery {
  cached(catalog: Catalog, env: Environment): CommandMetadata;
  discover(command: string, catalog: Catalog, env: Environment, signal?: AbortSignal): Promise<{ metadata: CommandMetadata; scriptFlags?: Flag[] }>;
}
