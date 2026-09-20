/** Shared repair library. No filesystem, subprocess, HTTP, worker or terminal side effects. */
export { suggest, historyCandidates, prepareHistory, type SuggestStage } from './suggestions.ts';
export { repairDirectory, directoryInput } from './path-repair.ts';
export { candidateValid, simpleWords } from './validation.ts';
export { Discovery, type DiscoveryIO } from './discovery.ts';
export type { EngineHost, Environment, MetadataDiscovery } from './host.ts';
export type { Candidate, Catalog, Flag } from './types.ts';
export type { CommandMetadata } from './command-policy.ts';
export type { DirectoryHost, DirectoryEntry, DirectorySnapshot, DirectoryLookup, FileInfo } from './directory-types.ts';
