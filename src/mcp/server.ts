import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as dap from '../debug/dapBridge';

// Optional session selector. Agents can target a specific debug session by id.
const sessionIdSchema = z.string().min(1).optional();

// Convenience helpers for the MCP SDK response shape.
function okResult(): CallToolResult {
  return { content: [{ type: 'text', text: 'ok' }] };
}

function structuredResult(
  structuredContent: Record<string, unknown>
): CallToolResult & { structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}

function isNotStoppedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('notStopped')) {
    return true;
  }

  const errorWithBody = error as { body?: { error?: { id?: string } } };
  return errorWithBody?.body?.error?.id === 'notStopped';
}

// MCP server maps tool calls to DAP requests through the bridge.
export function makeServer(options: { version?: string } = {}): McpServer {
  const serverVersion = options.version ?? '0.0.1';
  const server = new McpServer(
    { name: 'xdebug-mcp', version: serverVersion },
    {
      instructions:
        'Expose Xdebug debugging controls and data through MCP. Requires an active PHP debug session.'
    }
  );

  // Resources are read-only views for the currently active debug session.
  server.registerResource(
    'Call Stack',
    new ResourceTemplate('xdebug://stack', { list: undefined }),
    {
      title: 'Call Stack',
      description: 'Active call stack frames (thread 1)'
    },
    async () => {
      const frames = await dap.stack({ threadId: 1 });
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
      const vars = firstScope
        ? await dap.variables({ variablesReference: firstScope.variablesReference })
        : [];
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

  // Session discovery and status reporting.
  server.registerTool(
    'list_sessions',
    {
      title: 'List Sessions',
      description: 'List known debug sessions',
      inputSchema: {}
    },
    async (): Promise<CallToolResult & { structuredContent: unknown }> => {
      const sessions = await dap.listSessions();
      return structuredResult({ sessions });
    }
  );

  server.registerTool(
    'status',
    {
      title: 'Session Status',
      description: 'Describe the active debug session and whether it is stopped',
      inputSchema: {
        sessionId: sessionIdSchema
      }
    },
    async ({ sessionId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const info = await dap.status(sessionId);
      return structuredResult({ status: info });
    }
  );

  // Thread/stack introspection for multi-threaded debuggers.
  server.registerTool(
    'threads',
    {
      title: 'Threads',
      description: 'List threads in the selected debug session',
      inputSchema: {
        sessionId: sessionIdSchema
      }
    },
    async ({ sessionId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const threads = await dap.threads(sessionId);
      return structuredResult({ threads });
    }
  );

  // Stack/variable tooling makes it easy for agents to inspect state.
  server.registerTool(
    'stack',
    {
      title: 'Stack Trace',
      description: 'Get stack frames for a thread',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
        startFrame: z.number().int().min(0).optional(),
        levels: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, threadId, startFrame, levels }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const frames = await dap.stack({ sessionId, threadId, startFrame, levels });
      return structuredResult({ frames });
    }
  );

  server.registerTool(
    'scopes',
    {
      title: 'Scopes',
      description: 'List scopes for a stack frame',
      inputSchema: {
        sessionId: sessionIdSchema,
        frameId: z.number().int().positive()
      }
    },
    async ({ sessionId, frameId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const scopes = await dap.scopes(frameId, sessionId);
      return structuredResult({ scopes });
    }
  );

  server.registerTool(
    'variables',
    {
      title: 'Variables',
      description: 'List variables for a scope or variable reference',
      inputSchema: {
        sessionId: sessionIdSchema,
        variablesReference: z.number().int().nonnegative(),
        start: z.number().int().min(0).optional(),
        count: z.number().int().positive().optional(),
        filter: z.enum(['indexed', 'named']).optional()
      }
    },
    async ({ sessionId, variablesReference, start, count, filter }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const variables = await dap.variables({ sessionId, variablesReference, start, count, filter });
      return structuredResult({ variables });
    }
  );

  // Snapshot bundles top frame + scopes + variables in one call to reduce round trips.
  server.registerTool(
    'snapshot',
    {
      title: 'Frame Snapshot',
      description: 'Fetch top frame, scopes, and variables in one call',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
        includeExpensive: z.boolean().optional(),
        maxVariables: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, threadId, includeExpensive, maxVariables }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const frames = await dap.stack({ sessionId, threadId, startFrame: 0, levels: 1 });
      const frame = frames[0];

      if (!frame) {
        return structuredResult({ frame: null, scopes: [] });
      }

      const scopes = await dap.scopes(frame.id, sessionId);
      const scopedVariables = [];

      for (const scope of scopes) {
        if (scope.expensive && !includeExpensive) {
          continue;
        }
        const variables = await dap.variables({
          sessionId,
          variablesReference: scope.variablesReference,
          count: maxVariables
        });
        scopedVariables.push({ scope, variables });
      }

      return structuredResult({ frame, scopes: scopedVariables });
    }
  );

  // Execution control.
  server.registerTool(
    'continue',
    {
      title: 'Continue',
      description: 'Continue execution',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.cont({ sessionId, threadId });
      return okResult();
    }
  );

  server.registerTool(
    'pause',
    {
      title: 'Pause',
      description: 'Pause execution',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.pause({ sessionId, threadId });
      return okResult();
    }
  );

  server.registerTool(
    'step_over',
    {
      title: 'Step Over',
      description: 'Step over',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.next({ sessionId, threadId });
      return okResult();
    }
  );

  server.registerTool(
    'step_in',
    {
      title: 'Step In',
      description: 'Step in',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.stepIn({ sessionId, threadId });
      return okResult();
    }
  );

  server.registerTool(
    'step_out',
    {
      title: 'Step Out',
      description: 'Step out',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.stepOut({ sessionId, threadId });
      return okResult();
    }
  );

  server.registerTool(
    'restart',
    {
      title: 'Restart',
      description: 'Restart the debug session',
      inputSchema: {
        sessionId: sessionIdSchema
      }
    },
    async ({ sessionId }): Promise<CallToolResult> => {
      await dap.restart(sessionId);
      return okResult();
    }
  );

  server.registerTool(
    'terminate',
    {
      title: 'Terminate',
      description: 'Terminate the debug session',
      inputSchema: {
        sessionId: sessionIdSchema,
        restart: z.boolean().optional()
      }
    },
    async ({ sessionId, restart }): Promise<CallToolResult> => {
      await dap.terminate({ sessionId, restart });
      return okResult();
    }
  );

  server.registerTool(
    'disconnect',
    {
      title: 'Disconnect',
      description: 'Disconnect from the debuggee',
      inputSchema: {
        sessionId: sessionIdSchema,
        terminateDebuggee: z.boolean().optional(),
        restart: z.boolean().optional(),
        suspendDebuggee: z.boolean().optional()
      }
    },
    async ({ sessionId, terminateDebuggee, restart, suspendDebuggee }): Promise<CallToolResult> => {
      await dap.disconnect({ sessionId, terminateDebuggee, restart, suspendDebuggee });
      return okResult();
    }
  );

  // Breakpoint management.
  server.registerTool(
    'set_breakpoint',
    {
      title: 'Set Breakpoint',
      description: 'Set file breakpoints with optional condition/hitCondition/logMessage',
      inputSchema: {
        sessionId: sessionIdSchema,
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
    async ({ sessionId, file, breakpoints }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const result = await dap.setFileBreakpoints({ sessionId, file, breakpoints });
      const structuredContent = {
        results: result.map(item => ({
          verified: !!item.verified,
          message: item.message
        }))
      };
      return structuredResult(structuredContent);
    }
  );

  server.registerTool(
    'clear_breakpoints',
    {
      title: 'Clear Breakpoints',
      description: 'Clear all file breakpoints for a path',
      inputSchema: {
        sessionId: sessionIdSchema,
        file: z.string()
      }
    },
    async ({ sessionId, file }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const result = await dap.clearFileBreakpoints({ sessionId, file });
      return structuredResult({ results: result });
    }
  );

  server.registerTool(
    'set_function_breakpoints',
    {
      title: 'Set Function Breakpoints',
      description: 'Set function breakpoints by name',
      inputSchema: {
        sessionId: sessionIdSchema,
        breakpoints: z.array(
          z.object({
            name: z.string().min(1),
            condition: z.string().optional(),
            hitCondition: z.string().optional()
          })
        )
      }
    },
    async ({ sessionId, breakpoints }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const results = await dap.setFunctionBreakpoints({ sessionId, breakpoints });
      return structuredResult({ results });
    }
  );

  server.registerTool(
    'set_exception_breakpoints',
    {
      title: 'Set Exception Breakpoints',
      description: 'Configure exception breakpoints by filter name',
      inputSchema: {
        sessionId: sessionIdSchema,
        filters: z.array(z.string().min(1)),
        exceptionOptions: z.array(z.unknown()).optional()
      }
    },
    async ({ sessionId, filters, exceptionOptions }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const results = await dap.setExceptionBreakpoints({ sessionId, filters, exceptionOptions });
      return structuredResult({ results });
    }
  );

  server.registerTool(
    'evaluate_expr',
    {
      title: 'Evaluate Expression',
      description: 'Evaluate an expression in a specific frame',
      inputSchema: {
        sessionId: sessionIdSchema,
        expr: z.string(),
        frameId: z.number().int().positive().optional(),
        context: z.enum(['watch', 'repl', 'hover', 'clipboard']).optional(),
        threadId: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, expr, frameId, context, threadId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      let resolvedFrameId = frameId;
      if (!resolvedFrameId) {
        const frames = await dap.stack({ sessionId, threadId, startFrame: 0, levels: 1 });
        resolvedFrameId = frames[0]?.id;
      }
      const evaluation = await dap.evaluate({ sessionId, expression: expr, frameId: resolvedFrameId, context });
      return structuredResult(evaluation);
    }
  );

  server.registerTool(
    'wait_for_stop',
    {
      title: 'Wait For Stop',
      description: 'Blocks until the target stops; returns top stack info',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
        pollMs: z.number().int().positive().default(300)
      }
    },
    async ({ sessionId, threadId, pollMs }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const poll = async () => {
        try {
          const frames = await dap.stack({ sessionId, threadId, startFrame: 0, levels: 1 });
          return frames[0];
        } catch (error) {
          if (isNotStoppedError(error)) {
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

      return structuredResult({ stopped: true, frame });
    }
  );

  return server;
}
