/**
 * A tool of the studio's MCP server (#8). Each tool is one module under
 * src/mcp/tools/ exporting a StudioTool, listed in src/mcp/tools/index.ts:
 * adding a tool is that module and one entry in the list.
 */
import type * as z from 'zod';

/** Where the server runs. */
export interface ToolEnv {
  /** Directory relative paths in tool arguments resolve against (the repository root). */
  root: string;
}

export interface StudioTool<S extends z.ZodObject = z.ZodObject> {
  /** `<area>.<verb>`, e.g. `graph.validate`. */
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
