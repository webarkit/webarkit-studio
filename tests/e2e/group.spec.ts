// #136: the group demo (three shapes in a Group on the marker, turned and bobbed by math nodes) runs on both renderers.
// On Babylon.js it is the same graph with the Three.js Renderer node replaced by a Babylon.js Renderer, as the PR says
// to try it by hand.
import { expect, test } from '@playwright/test';
import { loadDemo, run } from './helpers';

for (const renderer of ['three', 'babylon'] as const) {
  test(`pinball-group runs on ${renderer}: the group and its three shapes, driven by math nodes, with no error (#136)`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await loadDemo(page, 'pinball-group');
    await expect(page.locator('.studio-node .title span:text-is("Group")')).toHaveCount(1);
    if (renderer === 'babylon') {
      await page.evaluate(() => {
        const doc = JSON.parse(localStorage.getItem('webarkit-studio:autosave')!);
        Object.assign(doc.nodes.find((n: { type: string }) => n.type === 'three.renderer'), { type: 'babylon.renderer', params: {} });
        localStorage.setItem('webarkit-studio:autosave', JSON.stringify(doc));
      });
      await page.reload();
      await expect(page.locator('.studio-node .title span:text-is("Babylon.js Renderer")')).toHaveCount(1);
    }
    await run(page);
    await expect(page.locator('.ar-view canvas')).toHaveCount(1);
    await expect(page.locator('#log')).not.toContainText('✗');
    expect(errors).toEqual([]);
  });
}
