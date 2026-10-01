// Native entry points use the shared engine directly, without serialization or RPC.
import { suggest as portableSuggest, candidateValid as portableValid, repairDirectory as portableDirectory } from '../src/engine/index.ts';
import { localHost } from './host.ts';
import type { Candidate, Catalog, Flag } from '../src/protocol.ts';
import type { CommandMetadata } from '../src/engine/command-policy.ts';
import type { MetadataDiscovery, Environment } from '../src/engine/host.ts';
import type { SuggestStage } from '../src/engine/index.ts';
export { historyCandidates, prepareHistory, type SuggestStage } from '../src/engine/index.ts';
export { simpleWords } from '../src/engine/index.ts';
export { syntaxValid } from './syntax.ts';
export function suggest(input: string, catalog: Catalog, env: Environment, discovery: MetadataDiscovery, onStage?: (stage: SuggestStage) => void, signal?: AbortSignal) {
  return portableSuggest(input, catalog, env, discovery, localHost(catalog.cwd, env), onStage, signal);
}
export function candidateValid(input: string, candidate: Candidate, catalog: Catalog, env: Environment, metadata: CommandMetadata, scriptFlags?: Flag[], signal?: AbortSignal) {
  return portableValid(input, candidate, catalog, env, metadata, localHost(catalog.cwd), scriptFlags, signal);
}
export function repairDirectory(input: string, catalog: Catalog, home: string, signal?: AbortSignal) {
  return portableDirectory(input, catalog, home, localHost(catalog.cwd), signal);
}
