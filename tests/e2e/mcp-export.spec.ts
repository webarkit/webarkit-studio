// export_bundle (#8) on the real build (#47): the web server of this suite runs `npm run build`
// first, so the MCP server, started as clients start it, exports from what the build writes, with
// its default baseDir. The unit test (tests/unit/mcp-export.test.ts) uses a fake directory instead.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { unzipSync } from 'fflate';

test('export_bundle exports a tracking graph from the build with its default baseDir', async () => {
  const client = new Client({ name: 'webarkit-studio-e2e', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/main.ts'], cwd: process.cwd(), stderr: 'pipe' }));
  try {
    const out = join(mkdtempSync(join(tmpdir(), 'webarkit-mcp-e2e-')), 'app.zip');
    const result = await client.callTool({ name: 'export_bundle', arguments: { graphPath: 'public/graphs/pinball-three.json', out } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const names = Object.keys(unzipSync(new Uint8Array(readFileSync(out)))).map((n) => n.slice(n.indexOf('/') + 1));
    expect(names).toEqual(expect.arrayContaining(['index.html', 'graph.json', 'data/camera_para.dat', 'data/DataNFT/pinball.fset3']));
    // The tracker's worker files (jsartoolkit-nft/<version>/), which the build writes only into dist/.
    expect(names.filter((n) => n.startsWith('jsartoolkit-nft/') && n.endsWith('.worker.js')).length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});
