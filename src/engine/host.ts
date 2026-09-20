import type { Catalog, Flag } from './types.ts';
import type { CommandMetadata } from './command-policy.ts';

export type Environment = Record<string, string | undefined>;
import type { DirectoryHost } from './directory-types.ts';
export type { DirectoryEntry, FileInfo } from './directory-types.ts';
/** All host dependencies of the repair engine. No terminal writes or general exec. */
export interface EngineHost extends DirectoryHost {
  syntax(command: string, signal: AbortSignal): Promise<boolean>;
}
export interface MetadataDiscovery {
  cached(catalog: Catalog, env: Environment): CommandMetadata;
  discover(command: string, catalog: Catalog, env: Environment, signal?: AbortSignal): Promise<{ metadata: CommandMetadata; scriptFlags?: Flag[] }>;
}
