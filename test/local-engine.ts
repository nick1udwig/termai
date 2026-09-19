// Test adapter: existing behavior fixtures run against the browser engine with native facts.
import { suggest as portableSuggest } from '../src/engine/suggestions.ts';
import { candidateValid as portableValid } from '../src/engine/validation.ts';
import { repairDirectory as portableDirectory } from '../src/engine/path-repair.ts';
import { localHost } from '../server/host.ts';
import type { Candidate, Catalog, Flag } from '../src/protocol.ts';
import type { CommandMetadata } from '../src/engine/command-policy.ts';
import type { MetadataDiscovery, Environment } from '../src/engine/host.ts';
import type { SuggestStage } from '../src/engine/suggestions.ts';
export { historyCandidates, prepareHistory, type SuggestStage } from '../src/engine/suggestions.ts';
export { simpleWords } from '../src/engine/validation.ts';
export { syntaxValid } from '../server/syntax.ts';
export function suggest(input: string, catalog: Catalog, env: Environment, discovery: MetadataDiscovery, onStage?: (stage: SuggestStage) => void, signal?: AbortSignal) {
  return portableSuggest(input, catalog, env, discovery, localHost(catalog.cwd), onStage, signal);
}
export function candidateValid(input: string, candidate: Candidate, catalog: Catalog, env: Environment, metadata: CommandMetadata, scriptFlags?: Flag[], signal?: AbortSignal) {
  return portableValid(input, candidate, catalog, env, metadata, localHost(catalog.cwd), scriptFlags, signal);
}
export function repairDirectory(input: string, catalog: Catalog, home: string, signal?: AbortSignal) {
  return portableDirectory(input, catalog, home, localHost(catalog.cwd), signal);
}
