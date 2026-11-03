/**
 * A tool of the studio's MCP server (#8). Each tool is one module under
 * src/mcp/tools/ exporting a StudioTool, listed in src/mcp/tools/index.ts:
 * adding a tool is that module and one entry in the list.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as z from 'zod';

/** The repository root, whatever directory the server was started from. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Where the server runs. */
export interface ToolEnv {
  /** The repository root: relative paths in tool arguments resolve against it. */
  root: string;
}

export interface StudioTool<S extends z.ZodObject = z.ZodObject> {
  /**
   * `<area>_<verb>`, e.g. `graph_validate`. Issue #8 wrote them with a dot (`graph.validate`):
   * MCP allows it, but some clients and model APIs accept only letters, digits, `_` and `-`.
   */
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /**
   * Returns the tool's result, a JSON-safe object (the call's structuredContent).
   * Throwing makes the call a tool error with the error's message.
   */
  run(input: z.infer<S>, env: ToolEnv): object | Promise<object>;
}

/** Keeps a tool's input type when it is put in a list of StudioTool. */
export const defineTool = <S extends z.ZodObject>(tool: StudioTool<S>): StudioTool => tool as unknown as StudioTool;
