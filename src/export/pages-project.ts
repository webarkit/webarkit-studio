/**
 * "GitHub Pages project" export: the standalone app in site/, with a workflow that
 * deploys it, for the user to push to a repository of their own. The studio makes
 * no request to GitHub, and neither the export nor the workflow holds a credential.
 *
 *   <slug>-pages/site/…                              the standalone app (app-bundle.ts)
 *   <slug>-pages/.github/workflows/deploy-pages.yml  the deploy
 *   <slug>-pages/README.md                           the steps
 *   <slug>-pages/.gitattributes                      commits every file byte for byte
 */
import { strToU8, zipSync } from 'fflate';
import type { GraphDocument } from '../core/graph';
import { buildAppFiles } from './app-bundle';
import { slugify, type ExportContext, type ExportResult } from './exporters';

/**
 * Each action at a major version that runs on Node 24 (checked in each tag's action.yml). The
 * Pages actions' documentation named configure-pages@v5 and deploy-pages@v4, which run on Node 20.
 * `$default-branch` only works in starter templates, so the workflow names both usual branches:
 * a push to one that is not the default fails the environment's rule and deploys nothing.
 */
const WORKFLOW = `name: Deploy to GitHub Pages

on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v5
`;

const readme = (title: string) => `# ${title}

An AR app exported from WebARKit Studio, ready to publish on GitHub Pages. The app is in \`site/\`, and
\`.github/workflows/deploy-pages.yml\` deploys it each time you push. Nothing in this folder holds a token
or a password: you push with your usual access to GitHub.

Once published, anyone can read everything in this folder, including your graph and the files it uses.

## Publish it

Unzip this project with your system's own Extract command: some command-line tools garble names with accents.

1. Create a new, empty repository on GitHub. Make it public: Pages on a private repository needs a paid plan.
2. Before you push, in the repository, open Settings → Pages, and under "Build and deployment" set Source to
   **GitHub Actions**. The push starts the deploy, and without this its first run fails.
   GitHub then suggests some workflows. You do not need them: this project brings its own.
3. Open a terminal in the folder that holds this README.md, which becomes the root of the repository. Replace
   \`<you>\` and \`<repo>\` with your user name and the repository's name, and run:

   \`\`\`
   git init
   git add -A
   git commit -m "Publish the app"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   \`\`\`

4. Wait for the "Deploy to GitHub Pages" run to finish in the repository's Actions tab.
5. Open the URL the run shows, usually \`https://<you>.github.io/<repo>/\`.

A camera on a phone needs a secure page, and the HTTPS URL that Pages gives is one.

## If it fails

- **The push is refused, and it names a workflow:** if you push with a personal access token, it needs the
  \`workflow\` scope.
- **The run fails because Pages was not set up:** do step 2, then press "Re-run all jobs".
- **The run says \`Branch "main" is not allowed to deploy to github-pages\`:** open
  Settings → Environments → github-pages, allow the branch \`main\`, then press "Re-run all jobs".

## Update it

Export the project again, replace \`site/\` with the new one, then commit and push.
`;

/** The project's files as path → bytes, from the app's. Refuses a file that the deploy would leave out. */
export function assemblePagesProject(app: Record<string, Uint8Array>, doc: GraphDocument): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(app)) {
    // actions/upload-pages-artifact leaves out what starts with a dot, with no error. Only .nojekyll may: a deploy runs no Jekyll.
    if (path !== '.nojekyll' && path.split('/').some((part) => part.startsWith('.'))) {
      throw new Error(`${path}: a file or folder whose name starts with a dot does not reach GitHub Pages. Use a copy with another name, and export again.`);
    }
    files[`site/${path}`] = data;
  }
  files['.github/workflows/deploy-pages.yml'] = strToU8(WORKFLOW);
  files['README.md'] = strToU8(readme((doc.name ?? '').replace(/[<>&"]/g, '').replace(/ +/g, ' ').trim() || 'WebAR app'));
  files['.gitattributes'] = strToU8('* -text\n');
  return files;
}

export async function exportPagesProject(input: GraphDocument, ctx: ExportContext): Promise<ExportResult> {
  const { files: app, doc } = await buildAppFiles(input, ctx);
  const folder = `${slugify(doc.name)}-pages`;
  const files = assemblePagesProject(app, doc);
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [`${folder}/${path}`, data])), { level: 6 });
  ctx.log(`✓ ${folder}.zip: ${Object.keys(files).length} files, ${(zipped.byteLength / 1024 / 1024).toFixed(1)} MB. Its README.md has the steps to publish it.`);
  return { filename: `${folder}.zip`, blob: new Blob([zipped as BlobPart], { type: 'application/zip' }) };
}
