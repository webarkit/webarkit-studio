/** The tools of the studio's MCP server, in the order clients list them. Add a tool here. */
import type { StudioTool } from '../tool';
import { catalogList } from './catalog-list';
import { graphValidate } from './graph-validate';

export const TOOLS: StudioTool[] = [catalogList, graphValidate];
