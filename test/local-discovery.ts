import { Discovery as ClientDiscovery } from '../src/engine/discovery.ts';
import { HelpProvider } from '../server/help.ts';
import { describe } from '../server/catalog.ts';
import { probePool } from '../server/probes.ts';
export { commandsFromHelp, requiredFromHelp } from '../src/engine/help.ts';
export class Discovery extends ClientDiscovery {
  private provider: HelpProvider;
  constructor() {
    const provider = new HelpProvider();
    super({ help: (...args) => provider.read(...args), describe: (command, catalog, _env, signal) => describe(command, catalog.cwd, signal), busy: () => probePool.busy });
    this.provider = provider;
  }
  get stats() { return this.provider.stats; }
  override dispose() { super.dispose(); this.provider.dispose(); }
}
