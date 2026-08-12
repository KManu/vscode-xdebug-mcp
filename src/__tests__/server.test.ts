import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import Ajv from 'ajv';
import { zodToJsonSchema } from 'zod-to-json-schema';

// vscode mock is configured globally in src/__tests__/setup.ts

// Mock DAP bridge - we only test schema validation, not DAP behavior
vi.mock('../debug/dapBridge', () => ({
  stack: vi.fn().mockResolvedValue([]),
  scopes: vi.fn().mockResolvedValue([]),
  variables: vi.fn().mockResolvedValue([]),
  status: vi.fn().mockResolvedValue({ session: { id: 'test', name: 'Test', type: 'php' }, stopped: true }),
  threads: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]),
  setFileBreakpoints: vi.fn().mockResolvedValue([{ verified: true }]),
  clearFileBreakpoints: vi.fn().mockResolvedValue([]),
  setFunctionBreakpoints: vi.fn().mockResolvedValue([{ verified: true }]),
  setExceptionBreakpoints: vi.fn().mockResolvedValue([{ verified: true }]),
  evaluate: vi.fn().mockResolvedValue({ result: 'test' }),
  cont: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  next: vi.fn().mockResolvedValue(undefined),
  stepIn: vi.fn().mockResolvedValue(undefined),
  stepOut: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
  terminate: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  __addSessionForTesting: vi.fn(),
  __clearSessionsForTesting: vi.fn(),
}));

// Import after mocking
import { makeServer } from '../mcp/server';
import * as dapBridge from '../debug/dapBridge';
import * as vscode from 'vscode';

describe('server tool schema validation', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    vscode.debug.activeDebugSession = undefined;
    vi.clearAllMocks();
  });

  // Helper to get registered tool input schema
  function getToolInputSchema(server: ReturnType<typeof makeServer>, toolName: string): z.ZodObject<any> | undefined {
    const tools = (server as any)._registeredTools as Record<string, any>;
    const tool = tools?.[toolName];
    return tool?.inputSchema;
  }

  // Helper to validate input against schema
  function validateInput(schema: z.ZodObject<any>, input: Record<string, any>): { success: boolean; error?: z.ZodError } {
    const result = schema.safeParse(input);
    return { success: result.success, error: result.error };
  }

  describe('stack tool', () => {
    it('should accept valid input with all optional params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'stack');
      expect(schema).toBeDefined();

      const validInput = {
        sessionId: 'test-session',
        threadId: 1,
        startFrame: 0,
        levels: 10
      };
      const result = validateInput(schema!, validInput);
      expect(result.success).toBe(true);
    });

    it('should accept valid input with no params (all optional)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'stack');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with only threadId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'stack');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { threadId: 5 });
      expect(result.success).toBe(true);
    });

    it('should reject invalid threadId (non-positive)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'stack');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { threadId: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid threadId (negative)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'stack');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { threadId: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid startFrame (negative)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'stack');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { startFrame: -5 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid levels (non-positive)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'stack');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { levels: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe('scopes tool', () => {
    it('should accept valid input with frameId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'scopes');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { frameId: 1 });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with frameId and sessionId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'scopes');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { frameId: 5, sessionId: 'test-session' });
      expect(result.success).toBe(true);
    });

    it('should reject missing frameId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'scopes');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('frameId');
    });

    it('should accept frameId 0 (zero is a valid DAP frame ID)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'scopes');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { frameId: 0 });
      expect(result.success).toBe(true);
    });

    it('should reject invalid frameId (negative)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'scopes');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { frameId: -3 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid frameId (string)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'scopes');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { frameId: 'not-a-number' });
      expect(result.success).toBe(false);
    });
  });

  describe('variables tool', () => {
    it('should accept valid input with required variablesReference', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'variables');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { variablesReference: 1 });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with all params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'variables');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        variablesReference: 1,
        start: 0,
        count: 10,
        filter: 'indexed'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with named filter', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'variables');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        variablesReference: 1,
        filter: 'named'
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing variablesReference', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'variables');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('variablesReference');
    });

    it('should reject invalid variablesReference (negative)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'variables');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { variablesReference: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid filter value', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'variables');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        variablesReference: 1,
        filter: 'invalid'
      });
      expect(result.success).toBe(false);
    });
  });

  describe('set_breakpoint tool', () => {
    it('should accept valid input with required file and breakpoints', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_breakpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        breakpoints: [{ line: 10 }]
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with full breakpoint details', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_breakpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        breakpoints: [{
          line: 10,
          condition: '$x > 0',
          hitCondition: '>5',
          logMessage: 'x is {$x}'
        }]
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with multiple breakpoints', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_breakpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        breakpoints: [
          { line: 10 },
          { line: 20, condition: '$x > 5' },
          { line: 30, logMessage: 'hit' }
        ]
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing file', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_breakpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        breakpoints: [{ line: 10 }]
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('file');
    });

    it('should reject missing breakpoints', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_breakpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php'
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid breakpoint line (non-positive)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_breakpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        breakpoints: [{ line: 0 }]
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid breakpoint line (negative)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_breakpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        breakpoints: [{ line: -5 }]
      });
      expect(result.success).toBe(false);
    });
  });

  describe('set_logpoint tool', () => {
    it('should accept valid input with required file, line, and logMessage', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_logpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        logpoints: [{ line: 10, logMessage: 'log message' }]
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with full logpoint details', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_logpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        logpoints: [{
          line: 10,
          logMessage: 'log message',
          condition: '$x > 0',
          hitCondition: '>3'
        }]
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing file', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_logpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        logpoints: [{ line: 10, logMessage: 'msg' }]
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('file');
    });

    it('should reject missing logpoints', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_logpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php'
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty logMessage', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_logpoint');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        logpoints: [{ line: 10, logMessage: '' }]
      });
      expect(result.success).toBe(false);
    });
  });

  // Regression: structuredResult() injects success:true, so advertised outputSchemas
  // must allow it — otherwise real MCP clients reject every call. The SDK server
  // advertises the schema as JSON (zodToJsonSchema → additionalProperties: false)
  // and the SDK client validates each result's structuredContent against it with
  // Ajv (client/index.js cacheToolOutputSchemas + callTool). Mirror that exact path
  // here so these tests fail without the fix.
  describe('structured content vs advertised outputSchema', () => {
    // Mirrors the SDK client: compile the advertised (JSON) schema with Ajv.
    function compileClientValidator(tool: any): (value: unknown) => boolean {
      const schemaJson = zodToJsonSchema(tool.outputSchema, { strictUnions: true });
      const validate = new Ajv().compile(schemaJson);
      return (value: unknown) => validate(value) as boolean;
    }

    const toolsWithOutputSchema = ['set_breakpoint', 'set_logpoint'] as const;

    for (const toolName of toolsWithOutputSchema) {
      const args =
        toolName === 'set_breakpoint'
          ? { file: '/path/to/file.php', breakpoints: [{ line: 10 }] }
          : { file: '/path/to/file.php', logpoints: [{ line: 10, logMessage: 'hit' }] };

      it(`${toolName} structuredContent validates against its outputSchema (zod, server-side)`, async () => {
        const server = makeServer({ version: '0.0.1' });
        const tool = (server as any)._registeredTools[toolName];
        expect(tool?.outputSchema).toBeDefined();

        const result = await tool.callback(args, undefined);
        expect(result.structuredContent).toBeDefined();
        expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
      });

      it(`${toolName} structuredContent passes the SDK client's Ajv validation of the advertised schema`, async () => {
        const server = makeServer({ version: '0.0.1' });
        const tool = (server as any)._registeredTools[toolName];

        const result = await tool.callback(args, undefined);
        expect(compileClientValidator(tool)(result.structuredContent)).toBe(true);
      });

      it(`${toolName} outputSchema accepts the errorResult() shape ({ success: false, error })`, async () => {
        const server = makeServer({ version: '0.0.1' });
        const tool = (server as any)._registeredTools[toolName];

        const errorContent = { success: false, error: 'boom: session not found' };
        expect(tool.outputSchema.safeParse(errorContent).success).toBe(true);
        expect(compileClientValidator(tool)(errorContent)).toBe(true);
      });

      it(`${toolName} error result through the REAL safeHandler path validates (rejecting DAP call)`, async () => {
        const server = makeServer({ version: '0.0.1' });
        const tool = (server as any)._registeredTools[toolName];

        // Drive the actual callback with a rejecting DAP call so safeHandler's
        // errorResult() emits the real error shape (not a hand-constructed one).
        (dapBridge.setFileBreakpoints as any).mockRejectedValueOnce(new Error('boom: session not found'));

        const result = await tool.callback(args, undefined);
        expect(result.structuredContent).toEqual({ success: false, error: 'boom: session not found' });
        expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
        expect(compileClientValidator(tool)(result.structuredContent)).toBe(true);
      });
    }
  });

  describe('clear_breakpoints tool', () => {
    it('should accept valid input with required file', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'clear_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with sessionId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'clear_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        file: '/path/to/file.php',
        sessionId: 'test-session'
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing file', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'clear_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('file');
    });
  });

  describe('set_function_breakpoints tool', () => {
    it('should accept valid input with required names array', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_function_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        breakpoints: [{ name: 'myFunction' }]
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with multiple function breakpoints', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_function_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        breakpoints: [
          { name: 'function1' },
          { name: 'function2', condition: '$x > 0' }
        ]
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing breakpoints', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_function_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(false);
    });

    it('should reject empty name in breakpoints array', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_function_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        breakpoints: [{ name: '' }]
      });
      expect(result.success).toBe(false);
    });
  });

  describe('set_exception_breakpoints tool', () => {
    it('should accept valid input with required filters array', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_exception_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        filters: ['AllExceptions']
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with multiple filters', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_exception_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        filters: ['AllExceptions', 'UnhandledExceptions']
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional exceptionOptions', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_exception_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        filters: ['AllExceptions'],
        exceptionOptions: [{ type: 'some' }]
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing filters', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_exception_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(false);
    });

    it('should reject empty filter string', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'set_exception_breakpoints');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        filters: ['']
      });
      expect(result.success).toBe(false);
    });
  });

  describe('evaluate_expr tool', () => {
    it('should accept valid input with required expr', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'evaluate_expr');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        expr: '$x + 1'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional frameId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'evaluate_expr');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        expr: '$x + 1',
        frameId: 5
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with context', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'evaluate_expr');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        expr: '$x + 1',
        context: 'repl'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with all params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'evaluate_expr');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        expr: '$x + 1',
        frameId: 1,
        context: 'watch',
        threadId: 2
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing expr', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'evaluate_expr');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        frameId: 5
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('expr');
    });

    it('should reject invalid context value', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'evaluate_expr');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        expr: '$x + 1',
        context: 'invalid'
      });
      expect(result.success).toBe(false);
    });
  });

  describe('continue tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'continue');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional sessionId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'continue');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test-session' });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional threadId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'continue');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { threadId: 1 });
      expect(result.success).toBe(true);
    });
  });

  describe('pause tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'pause');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'pause');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test', threadId: 1 });
      expect(result.success).toBe(true);
    });
  });

  describe('step_over tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'step_over');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'step_over');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test', threadId: 2 });
      expect(result.success).toBe(true);
    });
  });

  describe('step_in tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'step_in');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'step_in');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test', threadId: 3 });
      expect(result.success).toBe(true);
    });
  });

  describe('step_out tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'step_out');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'step_out');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test', threadId: 4 });
      expect(result.success).toBe(true);
    });
  });

  describe('restart tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'restart');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional sessionId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'restart');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test-session' });
      expect(result.success).toBe(true);
    });
  });

  describe('terminate tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'terminate');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional restart', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'terminate');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { restart: true });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional sessionId and restart', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'terminate');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test', restart: false });
      expect(result.success).toBe(true);
    });
  });

  describe('disconnect tool (no required params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'disconnect');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional terminateDebuggee', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'disconnect');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { terminateDebuggee: true });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with all optional params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'disconnect');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        sessionId: 'test',
        terminateDebuggee: true,
        restart: false,
        suspendDebuggee: false
      });
      expect(result.success).toBe(true);
    });
  });

  describe('wait_for_stop tool', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'wait_for_stop');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional timeout', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'wait_for_stop');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { pollMs: 500 });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional sessionId and threadId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'wait_for_stop');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test', threadId: 1, pollMs: 300 });
      expect(result.success).toBe(true);
    });

    it('should reject invalid pollMs (non-positive)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'wait_for_stop');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { pollMs: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid pollMs (negative)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'wait_for_stop');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { pollMs: -100 });
      expect(result.success).toBe(false);
    });
  });

  describe('snapshot tool', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'snapshot');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional includeExpensive', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'snapshot');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { includeExpensive: true });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional maxVariables', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'snapshot');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { maxVariables: 100 });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with all optional params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'snapshot');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {
        sessionId: 'test',
        threadId: 1,
        includeExpensive: true,
        maxVariables: 50
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid maxVariables (non-positive)', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'snapshot');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { maxVariables: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe('threads tool (no params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'threads');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional sessionId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'threads');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test-session' });
      expect(result.success).toBe(true);
    });
  });

  describe('status tool (no params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'status');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });

    it('should accept valid input with optional sessionId', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'status');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, { sessionId: 'test-session' });
      expect(result.success).toBe(true);
    });
  });

  describe('list_sessions tool (no params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'list_sessions');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });
  });

  describe('list_resource_templates tool (no params)', () => {
    it('should accept valid input with no params', () => {
      const server = makeServer({ version: '0.0.1' });
      const schema = getToolInputSchema(server, 'list_resource_templates');
      expect(schema).toBeDefined();

      const result = validateInput(schema!, {});
      expect(result.success).toBe(true);
    });
  });
});

describe('server tool structuredContent verification', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    vscode.debug.activeDebugSession = undefined;
    vi.clearAllMocks();
  });

  // Helper to call a tool handler directly
  function callTool(
    server: ReturnType<typeof makeServer>,
    toolName: string,
    args: Record<string, any> = {}
  ): Promise<any> {
    const tools = (server as any)._registeredTools as Record<string, any>;
    const tool = tools?.[toolName];
    if (!tool?.callback) {
      throw new Error(`Tool ${toolName} not found or has no callback`);
    }
    return tool.callback(args);
  }

  describe('threads tool', () => {
    it('should return structuredContent with success:true and threads array', async () => {
      const mockThreads = [{ id: 1, name: 'main' }];
      (dapBridge.threads as any).mockResolvedValue(mockThreads);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'threads', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.threads).toEqual(mockThreads);
    });
  });

  describe('status tool', () => {
    it('should return structuredContent with success:true and status info', async () => {
      const mockStatus = {
        session: { id: 'test', name: 'Test', type: 'php' },
        stopped: true,
        threadId: 1
      };
      (dapBridge.status as any).mockResolvedValue(mockStatus);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'status', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.status).toEqual(mockStatus);
    });
  });

  describe('stack tool', () => {
    it('should return structuredContent with success:true and frames array', async () => {
      const mockFrames = [{ id: 1, name: 'main', line: 10 }];
      (dapBridge.stack as any).mockResolvedValue(mockFrames);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'stack', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.frames).toEqual(mockFrames);
    });
  });

  describe('scopes tool', () => {
    it('should return structuredContent with success:true and scopes array', async () => {
      const mockScopes = [{ name: 'Local', variablesReference: 1 }];
      (dapBridge.scopes as any).mockResolvedValue(mockScopes);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'scopes', { frameId: 1 });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.scopes).toEqual(mockScopes);
    });
  });

  describe('variables tool', () => {
    it('should return structuredContent with success:true and variables array', async () => {
      const mockVariables = [{ name: '$x', value: '1', type: 'int' }];
      (dapBridge.variables as any).mockResolvedValue(mockVariables);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'variables', { variablesReference: 1 });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.variables).toEqual(mockVariables);
    });
  });

  describe('set_breakpoint tool', () => {
    it('should return structuredContent with success:true and results array', async () => {
      const mockResults = [{ verified: true, message: 'breakpoint set' }];
      (dapBridge.setFileBreakpoints as any).mockResolvedValue(mockResults);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'set_breakpoint', {
        file: '/test.php',
        breakpoints: [{ line: 10 }]
      });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.results).toEqual(mockResults);
    });
  });

  describe('set_logpoint tool', () => {
    it('should return structuredContent with success:true and results array', async () => {
      const mockResults = [{ verified: true }];
      (dapBridge.setFileBreakpoints as any).mockResolvedValue(mockResults);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'set_logpoint', {
        file: '/test.php',
        logpoints: [{ line: 10, logMessage: 'log message' }]
      });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.results).toEqual(mockResults);
    });
  });

  describe('clear_breakpoints tool', () => {
    it('should return structuredContent with success:true and results array', async () => {
      const mockResults: Array<{ verified: boolean; message?: string }> = [];
      (dapBridge.clearFileBreakpoints as any).mockResolvedValue(mockResults);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'clear_breakpoints', { file: '/test.php' });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.results).toEqual(mockResults);
    });
  });

  describe('set_function_breakpoints tool', () => {
    it('should return structuredContent with success:true and results array', async () => {
      const mockResults = [{ verified: true }];
      (dapBridge.setFunctionBreakpoints as any).mockResolvedValue(mockResults);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'set_function_breakpoints', {
        breakpoints: [{ name: 'myFunction' }]
      });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.results).toEqual(mockResults);
    });
  });

  describe('set_exception_breakpoints tool', () => {
    it('should return structuredContent with success:true and results array', async () => {
      const mockResults = [{ verified: true }];
      (dapBridge.setExceptionBreakpoints as any).mockResolvedValue(mockResults);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'set_exception_breakpoints', {
        filters: ['AllExceptions']
      });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.results).toEqual(mockResults);
    });
  });

  describe('continue tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.cont as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'continue', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('pause tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.pause as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'pause', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('step_over tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.next as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'step_over', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('step_in tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.stepIn as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'step_in', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('step_out tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.stepOut as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'step_out', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('restart tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.restart as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'restart', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('terminate tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.terminate as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'terminate', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('disconnect tool', () => {
    it('should return structuredContent with success:true', async () => {
      (dapBridge.disconnect as any).mockResolvedValue(undefined);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'disconnect', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
    });
  });

  describe('evaluate_expr tool', () => {
    it('should return structuredContent with success:true and evaluation result', async () => {
      const mockEval = { result: '42', type: 'int' };
      (dapBridge.evaluate as any).mockResolvedValue(mockEval);
      (dapBridge.stack as any).mockResolvedValue([{ id: 1 }]);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'evaluate_expr', { expr: '$x + 1' });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.result).toBe('42');
    });
  });

  describe('wait_for_stop tool', () => {
    it('should return structuredContent with success:true and stopped:true when debuggee stops', async () => {
      // First call returns no frame (not stopped), second call returns a frame
      (dapBridge.stack as any)
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 1, name: 'main' }]);

      // Mock setTimeout to advance immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'wait_for_stop', { pollMs: 10 });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.stopped).toBe(true);
      expect(result.structuredContent.frame).toBeDefined();
    });

    it('should return structuredContent with success:true and frame data when already stopped', async () => {
      const mockFrame = { id: 1, name: 'main' };
      (dapBridge.stack as any).mockResolvedValue([mockFrame]);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'wait_for_stop', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.stopped).toBe(true);
      expect(result.structuredContent.frame).toEqual(mockFrame);
    });
  });

  describe('snapshot tool', () => {
    it('should return structuredContent with success:true, frame, and scopes when stopped', async () => {
      const mockFrames = [{ id: 1, name: 'main', line: 10 }];
      const mockScopes = [{ name: 'Local', variablesReference: 1, expensive: false }];
      const mockVariables = [{ name: '$x', value: '1' }];

      (dapBridge.stack as any).mockResolvedValue(mockFrames);
      (dapBridge.scopes as any).mockResolvedValue(mockScopes);
      (dapBridge.variables as any).mockResolvedValue(mockVariables);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'snapshot', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.frame).toEqual(mockFrames[0]);
      expect(result.structuredContent.scopes).toHaveLength(1);
    });

    it('should return structuredContent with frame:null and empty scopes when no frames', async () => {
      (dapBridge.stack as any).mockResolvedValue([]);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'snapshot', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.frame).toBeNull();
      expect(result.structuredContent.scopes).toEqual([]);
    });

    it('should skip expensive scopes unless includeExpensive is true', async () => {
      const mockFrames = [{ id: 1, name: 'main' }];
      const mockScopes = [
        { name: 'Local', variablesReference: 1, expensive: false },
        { name: 'Superglobals', variablesReference: 2, expensive: true }
      ];
      const mockLocalVars = [{ name: '$x', value: '1' }];

      (dapBridge.stack as any).mockResolvedValue(mockFrames);
      (dapBridge.scopes as any).mockResolvedValue(mockScopes);
      (dapBridge.variables as any).mockResolvedValue(mockLocalVars);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'snapshot', { includeExpensive: false });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.scopes).toHaveLength(1);
      expect(result.structuredContent.scopes[0].scope.name).toBe('Local');
    });

    it('should include expensive scopes when includeExpensive is true', async () => {
      const mockFrames = [{ id: 1, name: 'main' }];
      const mockScopes = [
        { name: 'Local', variablesReference: 1, expensive: false },
        { name: 'Superglobals', variablesReference: 2, expensive: true }
      ];
      const mockLocalVars = [{ name: '$x', value: '1' }];

      (dapBridge.stack as any).mockResolvedValue(mockFrames);
      (dapBridge.scopes as any).mockResolvedValue(mockScopes);
      (dapBridge.variables as any).mockResolvedValue(mockLocalVars);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'snapshot', { includeExpensive: true });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.scopes).toHaveLength(2);
    });
  });

  describe('list_sessions tool', () => {
    it('should return structuredContent with success:true and sessions array', async () => {
      const mockSessions = [{ id: 'test', name: 'Test', type: 'php' }];
      (dapBridge.listSessions as any).mockResolvedValue(mockSessions);

      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'list_sessions', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.sessions).toEqual(mockSessions);
    });
  });

  describe('list_resource_templates tool', () => {
    it('should return structuredContent with success:true and templates array', async () => {
      const server = makeServer({ version: '0.0.1' });
      const result = await callTool(server, 'list_resource_templates', {});

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.templates).toBeDefined();
      expect(Array.isArray(result.structuredContent.templates)).toBe(true);
    });
  });

  describe('wait_for_stop error propagation', () => {
    it('should propagate non-notStopped errors rather than retrying', async () => {
      // Mock dap.stack to throw a non-notStopped error (e.g., network error)
      (dapBridge.stack as any).mockRejectedValueOnce(new Error('Network error: connection refused'));

      // Mock setTimeout to advance immediately
      vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

      const server = makeServer({ version: '0.0.1' });

      // wait_for_stop errors are now caught by safeHandler and returned as structured error results
      const result = await callTool(server, 'wait_for_stop', { pollMs: 10 });
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.error).toContain('Network error');
    });

    it('should return structured error for non-notStopped errors with body.error.id set to something else', async () => {
      const error = new Error('Some unexpected DAP error');
      (error as any).body = { error: { id: 'other_error' } };
      (dapBridge.stack as any).mockRejectedValueOnce(error);

      vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

      const server = makeServer({ version: '0.0.1' });

      const result = await callTool(server, 'wait_for_stop', { pollMs: 10 });
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.error).toContain('Some unexpected DAP error');
    });
  });
});

describe('server resource handlers', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    vscode.debug.activeDebugSession = undefined;
    vi.clearAllMocks();
  });

  // Helper to get a registered static resource's readCallback
  function getStaticResourceCallback(
    server: ReturnType<typeof makeServer>,
    resourceUri: string
  ): ((uri: URL, extra: any) => Promise<any>) | undefined {
    const resources = (server as any)._registeredResources as Record<string, any>;
    return resources?.[resourceUri]?.readCallback;
  }

  // Helper to get a registered resource template's readCallback
  function getResourceTemplateCallback(
    server: ReturnType<typeof makeServer>,
    templateName: string
  ): ((uri: URL, variables: Record<string, string>, extra: any) => Promise<any>) | undefined {
    const templates = (server as any)._registeredResourceTemplates as Record<string, any>;
    return templates?.[templateName]?.readCallback;
  }

  describe('Resource: xdebug://stack', () => {
    it('should resolve and return stack frames when session has frames', async () => {
      const mockFrames = [
        { id: 1, name: 'main', line: 10, source: { name: 'index.php', path: '/var/www/index.php' } },
        { id: 2, name: 'helper', line: 25, source: { name: 'helper.php', path: '/var/www/helper.php' } }
      ];
      (dapBridge.stack as any).mockResolvedValueOnce(mockFrames);

      const server = makeServer({ version: '0.0.1' });
      const callback = getStaticResourceCallback(server, 'xdebug://stack');
      expect(callback).toBeDefined();

      const uri = new URL('xdebug://stack');
      const result = await callback!(uri, {});

      expect(result).toBeDefined();
      expect(result.contents).toBeDefined();
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('xdebug://stack');
      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toEqual(mockFrames);
      expect(dapBridge.stack).toHaveBeenCalledWith({ threadId: 1 });
    });

    it('should return empty array when no frames are available', async () => {
      (dapBridge.stack as any).mockResolvedValueOnce([]);

      const server = makeServer({ version: '0.0.1' });
      const callback = getStaticResourceCallback(server, 'xdebug://stack');
      expect(callback).toBeDefined();

      const uri = new URL('xdebug://stack');
      const result = await callback!(uri, {});

      expect(result.contents).toHaveLength(1);
      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toEqual([]);
    });
  });

  describe('Resource: xdebug://variables/{frameId}', () => {
    it('should return variables for a valid frameId', async () => {
      const mockScopes = [
        { name: 'Local', variablesReference: 100, expensive: false }
      ];
      const mockVariables = [
        { name: '$x', value: '42', type: 'int', variablesReference: 0 },
        { name: '$y', value: '"hello"', type: 'string', variablesReference: 0 }
      ];
      (dapBridge.scopes as any).mockResolvedValueOnce(mockScopes);
      (dapBridge.variables as any).mockResolvedValueOnce(mockVariables);

      const server = makeServer({ version: '0.0.1' });
      const callback = getResourceTemplateCallback(server, 'Frame Variables');
      expect(callback).toBeDefined();

      const uri = new URL('xdebug://variables/1');
      const result = await callback!(uri, { frameId: '1' }, {});

      expect(result).toBeDefined();
      expect(result.contents).toHaveLength(1);
      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toEqual(mockVariables);
      expect(dapBridge.scopes).toHaveBeenCalledWith(1);
      expect(dapBridge.variables).toHaveBeenCalledWith({ variablesReference: 100 });
    });

    it('should throw for non-numeric frameId', async () => {
      const server = makeServer({ version: '0.0.1' });
      const callback = getResourceTemplateCallback(server, 'Frame Variables');
      expect(callback).toBeDefined();

      const uri = new URL('xdebug://variables/abc');
      await expect(callback!(uri, { frameId: 'abc' }, {})).rejects.toThrow('frameId must be a number');
    });

    it('should throw for undefined frameId', async () => {
      const server = makeServer({ version: '0.0.1' });
      const callback = getResourceTemplateCallback(server, 'Frame Variables');
      expect(callback).toBeDefined();

      const uri = new URL('xdebug://variables/');
      await expect(callback!(uri, {}, {})).rejects.toThrow('frameId must be a number');
    });

    it('should return empty variables when frame has no scopes', async () => {
      (dapBridge.scopes as any).mockResolvedValueOnce([]);

      const server = makeServer({ version: '0.0.1' });
      const callback = getResourceTemplateCallback(server, 'Frame Variables');
      expect(callback).toBeDefined();

      const uri = new URL('xdebug://variables/5');
      const result = await callback!(uri, { frameId: '5' }, {});

      expect(result.contents).toHaveLength(1);
      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toEqual([]);
      // variables should not be called when there are no scopes
      expect(dapBridge.variables).not.toHaveBeenCalled();
    });
  });
});

describe('server tool outputSchema verification', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    vscode.debug.activeDebugSession = undefined;
    vi.clearAllMocks();
  });

  function getRegisteredTool(server: ReturnType<typeof makeServer>, toolName: string): any {
    const tools = (server as any)._registeredTools as Record<string, any>;
    return tools?.[toolName];
  }

  describe('set_breakpoint outputSchema', () => {
    it('should have outputSchema with results array of verified/message objects', () => {
      const server = makeServer({ version: '0.0.1' });
      const tool = getRegisteredTool(server, 'set_breakpoint');

      expect(tool).toBeDefined();
      expect(tool.outputSchema).toBeDefined();

      // Verify the schema structure by parsing valid data.
      // NOTE: structuredResult() always injects success:true, so the advertised
      // outputSchema must allow it (regression: SDK clients reject calls otherwise).
      const schema = tool.outputSchema;
      const validResult = { success: true, results: [{ verified: true, message: 'ok' }] };
      const parsed = schema.safeParse(validResult);
      expect(parsed.success).toBe(true);
    });

    it('should reject output without the success flag', () => {
      const server = makeServer({ version: '0.0.1' });
      const tool = getRegisteredTool(server, 'set_breakpoint');

      const schema = tool.outputSchema;
      // success is required (structuredResult/errorResult always inject it);
      // results is intentionally OPTIONAL (error results omit it).
      expect(schema.safeParse({ something: 'else' }).success).toBe(false);
      expect(schema.safeParse({ results: [{ verified: true }] }).success).toBe(false);
    });

    it('should accept success-only and error shapes (no results array)', () => {
      const server = makeServer({ version: '0.0.1' });
      const tool = getRegisteredTool(server, 'set_breakpoint');

      const schema = tool.outputSchema;
      expect(schema.safeParse({ success: true }).success).toBe(true);
      expect(schema.safeParse({ success: false, error: 'boom' }).success).toBe(true);
    });

    it('should reject output with invalid results item (missing verified)', () => {
      const server = makeServer({ version: '0.0.1' });
      const tool = getRegisteredTool(server, 'set_breakpoint');

      const schema = tool.outputSchema;
      const parsed = schema.safeParse({ success: true, results: [{ message: 'no verified field' }] });
      expect(parsed.success).toBe(false);
    });
  });

  describe('set_logpoint outputSchema', () => {
    it('should have outputSchema with results array of verified/message objects', () => {
      const server = makeServer({ version: '0.0.1' });
      const tool = getRegisteredTool(server, 'set_logpoint');

      expect(tool).toBeDefined();
      expect(tool.outputSchema).toBeDefined();

      const schema = tool.outputSchema;
      const validResult = { success: true, results: [{ verified: true }] };
      const parsed = schema.safeParse(validResult);
      expect(parsed.success).toBe(true);
    });

    it('should reject output without the success flag', () => {
      const server = makeServer({ version: '0.0.1' });
      const tool = getRegisteredTool(server, 'set_logpoint');

      const schema = tool.outputSchema;
      // success is required (structuredResult/errorResult always inject it);
      // results is intentionally OPTIONAL (error results omit it).
      expect(schema.safeParse({ something: 'else' }).success).toBe(false);
      expect(schema.safeParse({ results: [{ verified: true }] }).success).toBe(false);
    });

    it('should accept success-only and error shapes (no results array)', () => {
      const server = makeServer({ version: '0.0.1' });
      const tool = getRegisteredTool(server, 'set_logpoint');

      const schema = tool.outputSchema;
      expect(schema.safeParse({ success: true }).success).toBe(true);
      expect(schema.safeParse({ success: false, error: 'boom' }).success).toBe(true);
    });
  });

  describe('tools without outputSchema', () => {
    it('should not have outputSchema for tools that dont define one', () => {
      const server = makeServer({ version: '0.0.1' });

      // Tools that should NOT have outputSchema
      const toolsWithoutOutputSchema = ['stack', 'continue', 'pause', 'step_over', 'set_function_breakpoints'];

      for (const toolName of toolsWithoutOutputSchema) {
        const tool = getRegisteredTool(server, toolName);
        expect(tool).toBeDefined();
        expect(tool.outputSchema).toBeUndefined();
      }
    });
  });
});