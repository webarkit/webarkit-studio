/** The graph argument of the tools that read one: inline JSON or a file path. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as z from 'zod';
import type { ToolEnv } from './tool';

export const graphInput = {
  graph: z.record(z.string(), z.unknown()).optional().describe('The graph document (JSON). Give this or graphPath.'),
  graphPath: z.string().optional().describe('Path of a graph .json file, relative to the repository root. Give this or graph.'),
};

/** The graph of a tool call, not validated yet. */
export function readGraphInput(input: { graph?: Record<string, unknown>; graphPath?: string }, env: ToolEnv): unknown {
  if ((input.graph === undefined) === (input.graphPath === undefined)) throw new Error('give exactly one of graph and graphPath');
  if (input.graph !== undefined) return input.graph;
  const path = resolve(env.root, input.graphPath!);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${input.graphPath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${input.graphPath} is not JSON`);
  }
}
