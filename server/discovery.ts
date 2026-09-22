import { Discovery as SharedDiscovery } from '../src/engine/index.ts';
import { HelpProvider } from './help.ts';
import { describe } from './catalog.ts';
import { probePool } from './probes.ts';
export { commandsFromHelp, requiredFromHelp } from '../src/engine/help.ts';
export class Discovery extends SharedDiscovery {
  private provider: HelpProvider;
  constructor() {
    const provider = new HelpProvider();
    super({ help: (...args) => provider.readVerifiedRoute(...args), describe: (command, catalog, _env, signal) => describe(command, catalog.cwd, signal), busy: () => probePool.busy });
    this.provider = provider;
  }
  get stats() { return this.provider.stats; }
  override dispose() { super.dispose(); this.provider.dispose(); }
}
