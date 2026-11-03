// Installs the plugins of webarkit-studio.config.ts before every test file, as the studio does at startup.
import config from '../../webarkit-studio.config';
import { loadPlugins } from '../../src/plugins/host';

await loadPlugins(config);
