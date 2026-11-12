/**
 * trackability_check: rates how well a dataset will track (#44), through the
 * dataset check its plugin provides (dataset-checks.ts).
 */
import * as z from 'zod';
import { DATASET_CHECKS } from '../dataset-checks';
import { defineTool } from '../tool';

export const trackabilityCheck = defineTool({
  name: 'trackability_check',
  title: 'Rate how well a dataset will track',
  description:
    'Rates how well a tracker dataset will track, from the feature points in its files, without running the tracker. A poor dataset is a result, not an error. ' +
    'Returns dataset, thresholds, verdict (good, fair or poor), marker (its size) and checks (per check: id, label, value, limits, direction, status and a hint ' +
    'on what to change in the image), the same report as npm run trackability -- <dataset> --json, with the default thresholds.',
  inputSchema: z.object({
    dataset: z
      .string()
      .min(1)
      .describe('Dataset path without extension, or any of its files (absolute or relative to the repository root). A packed dataset is not supported.'),
  }),
  run(input, env) {
    const checks = Object.entries(DATASET_CHECKS);
    if (checks.length === 0) throw new Error('no loaded plugin provides a dataset check');
    if (checks.length > 1) throw new Error(`several plugins provide a dataset check (${checks.map(([id]) => id).join(', ')}): this tool cannot choose between them yet`);
    return checks[0][1].check(input.dataset, env.root);
  },
});
