/** The tools of the studio's MCP server, in the order clients list them. Add a tool here. */
import type { StudioTool } from '../tool';
import { catalogList } from './catalog-list';
import { graphCreate, graphEdit } from './graph-edit';
import { graphValidate } from './graph-validate';
import { trackingRun } from './tracking-run';

export const TOOLS: StudioTool[] = [catalogList, graphValidate, graphCreate, graphEdit, trackingRun];
