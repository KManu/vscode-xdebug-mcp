import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as dap from '../debug/dapBridge';
import { isNotStoppedError } from '../debug/errors';

// Optional session selector. Agents can target a specific debug session by id.
const sessionIdSchema = z.string().min(1).optional();

// Convenience helpers for the MCP SDK response shape.
function okResult(): CallToolResult & { structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { success: true },
  };
}

function structuredResult(
  structuredContent: Record<string, unknown>
): CallToolResult & { structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, ...structuredContent }) }],
    structuredContent: { success: true, ...structuredContent },
  };
}

function errorResult(error: unknown): CallToolResult & { structuredContent: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { success: false, error: message },
  };
}

// Higher-order wrapper that catches errors and converts them to structured error results.
function safeHandler(fn: (...args: any[]) => Promise<any>): (...args: any[]) => Promise<any> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

// MCP server maps tool calls to DAP requests through the bridge.
export function makeServer(options: { version?: string } = {}): McpServer {
  const serverVersion = options.version ?? '0.0.1';
  const server = new McpServer(
    { name: 'xdebug-mcp', version: serverVersion },
    {
      instructions: 'Expose Xdebug debugging controls and data through MCP. Requires an active PHP debug session.',
    }
  );

  const resourceTemplates: Array<{
    name: string;
    uriTemplate: string;
    title: string;
    description: string;
  }> = [];

  // Resources are read-only views for the currently active debug session.
  server.registerResource(
    'Call Stack',
    'xdebug://stack',
    {
      title: 'Call Stack',
      description: 'Active call stack frames (thread 1)',
    },
    async (uri) => {
      const frames = await dap.stack({ threadId: 1 });
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(frames, null, 2),
          },
        ],
      };
    }
  );

  resourceTemplates.push({
    name: 'Frame Variables',
    uriTemplate: 'xdebug://variables/{frameId}',
    title: 'Variables',
    description: 'Variables in a frame (first scope)',
  });

  server.registerResource(
    'Frame Variables',
    new ResourceTemplate('xdebug://variables/{frameId}', { list: undefined }),
    {
      title: 'Variables',
      description: 'Variables in a frame (first scope)',
    },
    async (_uri, variables) => {
      const frameId = Number(variables?.frameId);
      if (Number.isNaN(frameId)) {
        throw new Error('frameId must be a number');
      }
      const scopes = await dap.scopes(frameId);
      const firstScope = scopes[0];
      const vars = firstScope ? await dap.variables({ variablesReference: firstScope.variablesReference }) : [];
      return {
        contents: [
          {
            uri: `xdebug://variables/${frameId}`,
            text: JSON.stringify(vars, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'list_resource_templates',
    {
      title: 'List Resource Templates',
      description: 'List resource templates exposed by this MCP server',
      inputSchema: {},
    },
    safeHandler(async (): Promise<CallToolResult & { structuredContent: unknown }> => {
      return structuredResult({ templates: resourceTemplates });
    })
  );

  server.registerPrompt(
    'xdebug_mcp_capabilities',
    {
      title: 'Xdebug MCP Capabilities',
      description: 'Discover tools/resources and how to use this Xdebug MCP server',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'You are connected to the Xdebug MCP server inside VS Code. ' +
              'Please discover and summarize all available capabilities for the user. ' +
              'First list available tools, then list resources, and then list resource templates (if resources is empty). ' +
              "Use the tool 'list_resource_templates' if resource templates are not visible via standard MCP listing. " +
              "Call 'list_sessions' and 'status' to explain session requirements. " +
              'Mention that most inspection calls require the debug session to be stopped. ' +
              "Show how to read 'xdebug://stack' and 'xdebug://variables/{frameId}', and explain how to set breakpoints/logpoints with workspace-relative or absolute local paths.",
          },
        },
      ],
    })
  );

  // Session discovery and status reporting.
  server.registerTool(
    'list_sessions',
    {
      title: 'List Sessions',
      description: 'List known debug sessions',
      inputSchema: {},
    },
    safeHandler(async (): Promise<CallToolResult & { structuredContent: unknown }> => {
      const sessions = await dap.listSessions();
      return structuredResult({ sessions });
    })
  );

  server.registerTool(
    'status',
    {
      title: 'Session Status',
      description: 'Describe the active debug session and whether it is stopped',
      inputSchema: {
        sessionId: sessionIdSchema,
      },
    },
    safeHandler(async ({ sessionId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const info = await dap.status(sessionId);
      return structuredResult({ status: info });
    })
  );

  server.registerTool(
    'diagnostics',
    {
      title: 'Diagnostics',
      description: 'Report MCP server health and Xdebug configuration status',
      inputSchema: {
        sessionId: sessionIdSchema,
      },
    },
    safeHandler(async ({ sessionId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const sessions = await dap.listSessions();
      const hasActiveSession = sessions.length > 0;

      let sessionStatus: dap.DebugStatus | null = null;
      if (hasActiveSession) {
        try {
          sessionStatus = await dap.status(sessionId);
        } catch {
          // Session may have died between listSessions and status
        }
      }

      const recommendations: string[] = [];
      if (!hasActiveSession) {
        recommendations.push('No active debug session. Start a PHP/Xdebug debug session in VS Code (F5).');
        recommendations.push(
          'Ensure Xdebug is configured with xdebug.mode=debug and xdebug.client_port matches launch.json.'
        );
      } else if (sessionStatus && !sessionStatus.stopped) {
        recommendations.push('Debug session is running. Set a breakpoint and trigger a PHP request to stop execution.');
        recommendations.push('Use wait_for_stop to block until a breakpoint is hit, or pause to interrupt.');
      } else if (sessionStatus && sessionStatus.stopped) {
        recommendations.push(
          'Debug session is stopped and ready for inspection. Use stack, scopes, variables, or snapshot to inspect state.'
        );
      }

      return structuredResult({
        server: 'running',
        version: serverVersion,
        sessions: sessions.map((s) => ({ id: s.id, name: s.name, type: s.type })),
        sessionCount: sessions.length,
        hasActiveSession,
        sessionStopped: sessionStatus?.stopped ?? false,
        threadId: sessionStatus?.threadId,
        threadCount: sessionStatus?.threads?.length ?? 0,
        recommendations,
      });
    })
  );

  // Thread/stack introspection for multi-threaded debuggers.
  server.registerTool(
    'threads',
    {
      title: 'Threads',
      description: 'List threads in the selected debug session',
      inputSchema: {
        sessionId: sessionIdSchema,
      },
    },
    safeHandler(async ({ sessionId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const threads = await dap.threads(sessionId);
      return structuredResult({ threads });
    })
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
        levels: z.number().int().positive().optional(),
      },
    },
    safeHandler(
      async ({ sessionId, threadId, startFrame, levels }): Promise<CallToolResult & { structuredContent: unknown }> => {
        const frames = await dap.stack({ sessionId, threadId, startFrame, levels });
        return structuredResult({ frames });
      }
    )
  );

  server.registerTool(
    'scopes',
    {
      title: 'Scopes',
      description: 'List scopes for a stack frame',
      inputSchema: {
        sessionId: sessionIdSchema,
        frameId: z.number().int().min(0),
      },
    },
    safeHandler(async ({ sessionId, frameId }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const scopes = await dap.scopes(frameId, sessionId);
      return structuredResult({ scopes });
    })
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
        filter: z.enum(['indexed', 'named']).optional(),
      },
    },
    safeHandler(
      async ({
        sessionId,
        variablesReference,
        start,
        count,
        filter,
      }): Promise<CallToolResult & { structuredContent: unknown }> => {
        const variables = await dap.variables({ sessionId, variablesReference, start, count, filter });
        return structuredResult({ variables });
      }
    )
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
        maxVariables: z.number().int().positive().optional(),
      },
    },
    safeHandler(
      async ({
        sessionId,
        threadId,
        includeExpensive,
        maxVariables,
      }): Promise<CallToolResult & { structuredContent: unknown }> => {
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
            count: maxVariables,
          });
          scopedVariables.push({ scope, variables });
        }

        return structuredResult({ frame, scopes: scopedVariables });
      }
    )
  );

  // Execution control.
  server.registerTool(
    'continue',
    {
      title: 'Continue',
      description: 'Continue execution',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
      },
    },
    safeHandler(async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.cont({ sessionId, threadId });
      return okResult();
    })
  );

  server.registerTool(
    'pause',
    {
      title: 'Pause',
      description: 'Pause execution',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
      },
    },
    safeHandler(async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.pause({ sessionId, threadId });
      return okResult();
    })
  );

  server.registerTool(
    'step_over',
    {
      title: 'Step Over',
      description: 'Step over',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
      },
    },
    safeHandler(async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.next({ sessionId, threadId });
      return okResult();
    })
  );

  server.registerTool(
    'step_in',
    {
      title: 'Step In',
      description: 'Step in',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
      },
    },
    safeHandler(async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.stepIn({ sessionId, threadId });
      return okResult();
    })
  );

  server.registerTool(
    'step_out',
    {
      title: 'Step Out',
      description: 'Step out',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
      },
    },
    safeHandler(async ({ sessionId, threadId }): Promise<CallToolResult> => {
      await dap.stepOut({ sessionId, threadId });
      return okResult();
    })
  );

  server.registerTool(
    'restart',
    {
      title: 'Restart',
      description: 'Restart the debug session',
      inputSchema: {
        sessionId: sessionIdSchema,
      },
    },
    safeHandler(async ({ sessionId }): Promise<CallToolResult> => {
      await dap.restart({ sessionId });
      return okResult();
    })
  );

  server.registerTool(
    'terminate',
    {
      title: 'Terminate',
      description: 'Terminate the debug session',
      inputSchema: {
        sessionId: sessionIdSchema,
        restart: z.boolean().optional(),
      },
    },
    safeHandler(async ({ sessionId, restart }): Promise<CallToolResult> => {
      await dap.terminate({ sessionId, restart });
      return okResult();
    })
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
        suspendDebuggee: z.boolean().optional(),
      },
    },
    safeHandler(async ({ sessionId, terminateDebuggee, restart, suspendDebuggee }): Promise<CallToolResult> => {
      await dap.disconnect({ sessionId, terminateDebuggee, restart, suspendDebuggee });
      return okResult();
    })
  );

  // Breakpoint management.
  server.registerTool(
    'set_breakpoint',
    {
      title: 'Set Breakpoint',
      description:
        'Set file breakpoints (workspace-relative or absolute local paths) with optional condition/hitCondition/logMessage',
      inputSchema: {
        sessionId: sessionIdSchema,
        file: z.string(),
        breakpoints: z.array(
          z.object({
            line: z.number().int().positive(),
            condition: z.string().optional(),
            hitCondition: z.string().optional(),
            logMessage: z.string().optional(),
          })
        ),
      },
      outputSchema: {
        results: z.array(
          z.object({
            verified: z.boolean(),
            message: z.string().optional(),
          })
        ),
      },
    },
    safeHandler(async ({ sessionId, file, breakpoints }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const result = await dap.setFileBreakpoints({ sessionId, file, breakpoints });
      const structuredContent = {
        results: result.map((item: { verified?: boolean; message?: string }) => ({
          verified: !!item.verified,
          message: item.message,
        })),
      };
      return structuredResult(structuredContent);
    })
  );

  server.registerTool(
    'set_logpoint',
    {
      title: 'Set Logpoint',
      description: 'Set file logpoints (logMessage) with optional condition/hitCondition',
      inputSchema: {
        sessionId: sessionIdSchema,
        file: z.string(),
        logpoints: z.array(
          z.object({
            line: z.number().int().positive(),
            logMessage: z.string().min(1),
            condition: z.string().optional(),
            hitCondition: z.string().optional(),
          })
        ),
      },
      outputSchema: {
        results: z.array(
          z.object({
            verified: z.boolean(),
            message: z.string().optional(),
          })
        ),
      },
    },
    safeHandler(async ({ sessionId, file, logpoints }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const breakpoints = logpoints.map(
        (item: { line: number; logMessage: string; condition?: string; hitCondition?: string }) => ({
          line: item.line,
          logMessage: item.logMessage,
          condition: item.condition,
          hitCondition: item.hitCondition,
        })
      );
      const result = await dap.setFileBreakpoints({ sessionId, file, breakpoints });
      const structuredContent = {
        results: result.map((item: { verified?: boolean; message?: string }) => ({
          verified: !!item.verified,
          message: item.message,
        })),
      };
      return structuredResult(structuredContent);
    })
  );

  server.registerTool(
    'clear_breakpoints',
    {
      title: 'Clear Breakpoints',
      description: 'Clear all file breakpoints for a path',
      inputSchema: {
        sessionId: sessionIdSchema,
        file: z.string(),
      },
    },
    safeHandler(async ({ sessionId, file }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const result = await dap.clearFileBreakpoints({ sessionId, file });
      return structuredResult({ results: result });
    })
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
            hitCondition: z.string().optional(),
          })
        ),
      },
    },
    safeHandler(async ({ sessionId, breakpoints }): Promise<CallToolResult & { structuredContent: unknown }> => {
      const results = await dap.setFunctionBreakpoints({ sessionId, breakpoints });
      return structuredResult({ results });
    })
  );

  server.registerTool(
    'set_exception_breakpoints',
    {
      title: 'Set Exception Breakpoints',
      description: 'Configure exception breakpoints by filter name',
      inputSchema: {
        sessionId: sessionIdSchema,
        filters: z.array(z.string().min(1)),
        exceptionOptions: z.array(z.unknown()).optional(),
      },
    },
    safeHandler(
      async ({ sessionId, filters, exceptionOptions }): Promise<CallToolResult & { structuredContent: unknown }> => {
        const results = await dap.setExceptionBreakpoints({ sessionId, filters, exceptionOptions });
        return structuredResult({ results });
      }
    )
  );

  server.registerTool(
    'evaluate_expr',
    {
      title: 'Evaluate Expression',
      description: 'Evaluate an expression in a specific frame',
      inputSchema: {
        sessionId: sessionIdSchema,
        expr: z.string(),
        frameId: z.number().int().min(0).optional(),
        context: z.enum(['watch', 'repl', 'hover', 'clipboard']).optional(),
        threadId: z.number().int().positive().optional(),
      },
    },
    safeHandler(
      async ({
        sessionId,
        expr,
        frameId,
        context,
        threadId,
      }): Promise<CallToolResult & { structuredContent: unknown }> => {
        let resolvedFrameId = frameId;
        if (!resolvedFrameId) {
          const frames = await dap.stack({ sessionId, threadId, startFrame: 0, levels: 1 });
          resolvedFrameId = frames[0]?.id;
        }
        const evaluation = await dap.evaluate({ sessionId, expression: expr, frameId: resolvedFrameId, context });
        return structuredResult(evaluation);
      }
    )
  );

  server.registerTool(
    'wait_for_stop',
    {
      title: 'Wait For Stop',
      description: 'Blocks until the target stops; returns top stack info',
      inputSchema: {
        sessionId: sessionIdSchema,
        threadId: z.number().int().positive().optional(),
        pollMs: z.number().int().positive().default(300),
        timeoutMs: z.number().int().positive().optional().default(30000),
      },
    },
    safeHandler(
      async ({ sessionId, threadId, pollMs, timeoutMs }): Promise<CallToolResult & { structuredContent: unknown }> => {
        const deadline = Date.now() + (timeoutMs ?? 30000);

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
          if (Date.now() > deadline) {
            return errorResult(
              new Error(
                `Timed out waiting for debugger to stop after ${timeoutMs ?? 30000}ms. ` +
                  'Ensure Xdebug is configured, a PHP request was triggered, and a breakpoint is set.'
              )
            );
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          frame = await poll();
        }

        return structuredResult({ stopped: true, frame });
      }
    )
  );

  return server;
}

// === Exported output schemas for integration test validation ===
// These mirror the structuredContent shapes produced by each tool.

export const outputSchemas = {
  setBreakpoint: z.object({
    success: z.literal(true),
    results: z.array(
      z.object({
        verified: z.boolean(),
        message: z.string().optional(),
      })
    ),
  }),
  setLogpoint: z.object({
    success: z.literal(true),
    results: z.array(
      z.object({
        verified: z.boolean(),
        message: z.string().optional(),
      })
    ),
  }),
  status: z.object({
    success: z.literal(true),
    status: z.object({
      session: z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        workspaceFolder: z.string().optional(),
      }),
      stopped: z.boolean(),
      threadId: z.number().optional(),
      threads: z
        .array(
          z.object({
            id: z.number(),
            name: z.string(),
          })
        )
        .optional(),
    }),
  }),
  stack: z.object({
    success: z.literal(true),
    frames: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        line: z.number(),
        column: z.number().optional(),
        source: z.unknown().optional(),
      })
    ),
  }),
  scopes: z.object({
    success: z.literal(true),
    scopes: z.array(
      z.object({
        name: z.string(),
        variablesReference: z.number(),
        expensive: z.boolean().optional(),
      })
    ),
  }),
  variables: z.object({
    success: z.literal(true),
    variables: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        type: z.string().optional(),
        variablesReference: z.number().optional(),
      })
    ),
  }),
  waitForStop: z.object({
    success: z.literal(true),
    stopped: z.literal(true),
    frame: z.object({
      id: z.number(),
      name: z.string(),
      line: z.number(),
    }),
  }),
  listSessions: z.object({
    success: z.literal(true),
    sessions: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        workspaceFolder: z.string().optional(),
      })
    ),
  }),
} as const;

export type OutputSchemaName = keyof typeof outputSchemas;
