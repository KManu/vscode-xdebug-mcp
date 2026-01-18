import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as dap from '../debug/dapBridge';

export function makeServer(): McpServer {
  const server = new McpServer(
    { name: 'xdebug-mcp', version: '0.0.1' },
    {
      instructions:
        'Expose Xdebug debugging controls and data through MCP. Requires an active PHP debug session.'
    }
  );

  server.registerResource(
    'Call Stack',
    new ResourceTemplate('xdebug://stack', { list: undefined }),
    {
      title: 'Call Stack',
      description: 'Active call stack frames (thread 1)'
    },
    async () => {
      const frames = await dap.stack(1);
      return {
        contents: [
          {
            uri: 'xdebug://stack',
            text: JSON.stringify(frames, null, 2)
          }
        ]
      };
    }
  );

  server.registerResource(
    'Frame Variables',
    new ResourceTemplate('xdebug://variables/{frameId}', { list: undefined }),
    {
      title: 'Variables',
      description: 'Variables in a frame (first scope)'
    },
    async (_uri, variables) => {
      const frameId = Number(variables?.frameId);
      if (Number.isNaN(frameId)) {
        throw new Error('frameId must be a number');
      }
      const scopes = await dap.scopes(frameId);
      const firstScope = scopes[0];
      const vars = firstScope ? await dap.variables(firstScope.variablesReference) : [];
      return {
        contents: [
          {
            uri: `xdebug://variables/${frameId}`,
            text: JSON.stringify(vars, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    'continue',
    {
      title: 'Continue',
      description: 'Continue execution',
      inputSchema: {
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ threadId }): Promise<CallToolResult> => {
      await dap.cont(threadId ?? 1);
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  server.registerTool(
    'step_over',
    {
      title: 'Step Over',
      description: 'Step over',
      inputSchema: {
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ threadId }): Promise<CallToolResult> => {
      await dap.next(threadId ?? 1);
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  server.registerTool(
    'step_in',
    {
      title: 'Step In',
      description: 'Step in',
      inputSchema: {
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ threadId }): Promise<CallToolResult> => {
      await dap.stepIn(threadId ?? 1);
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  server.registerTool(
    'step_out',
    {
      title: 'Step Out',
      description: 'Step out',
      inputSchema: {
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ threadId }): Promise<CallToolResult> => {
      await dap.stepOut(threadId ?? 1);
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  server.registerTool(
    'set_breakpoint',
    {
      title: 'Set Breakpoint',
      description: 'Set file breakpoints with optional condition/hitCondition/logMessage',
      inputSchema: {
        file: z.string(),
        breakpoints: z.array(
          z.object({
            line: z.number().int().positive(),
            condition: z.string().optional(),
            hitCondition: z.string().optional(),
            logMessage: z.string().optional()
          })
        )
      },
      outputSchema: {
        results: z.array(
          z.object({
            verified: z.boolean(),
            message: z.string().optional()
          })
        )
      }
    },
    async ({ file, breakpoints }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const result = await dap.setFileBreakpoints(file, breakpoints);
      const structuredContent = {
        results: result.map(item => ({
          verified: !!item.verified,
          message: item.message
        }))
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent
      };
    }
  );

  server.registerTool(
    'evaluate_expr',
    {
      title: 'Evaluate Expression',
      description: 'Evaluate in top frame',
      inputSchema: {
        expr: z.string()
      }
    },
    async ({ expr }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const frames = await dap.stack(1);
      const frameId = frames[0]?.id;
      const evaluation = await dap.evaluate(expr, frameId);
      return {
        content: [{ type: 'text', text: JSON.stringify(evaluation) }],
        structuredContent: evaluation
      };
    }
  );

  server.registerTool(
    'wait_for_stop',
    {
      title: 'Wait For Stop',
      description: 'Blocks until the target stops; returns top stack info',
      inputSchema: {
        pollMs: z.number().int().positive().default(300)
      }
    },
    async ({ pollMs }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const poll = async () => {
        try {
          const frames = await dap.stack(1);
          return frames[0];
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('notStopped')) {
            return undefined;
          }
          throw error;
        }
      };

      let frame = await poll();
      while (!frame) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        frame = await poll();
      }

      const structuredContent = { stopped: true, frame };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent
      };
    }
  );

  return server;
}
