// src/test/fixtures/mockDebugAdapter.ts
// Full mock VS Code DebugAdapter implementing 20 DAP messages for integration testing.
// Registered under debug type "xdebug-mcp-test". No PHP/Xdebug required.
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Internal DAP message types for narrow casting inside handleMessage.
// ---------------------------------------------------------------------------
interface DapRequest {
  seq: number;
  command: string;
  arguments?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API – register / unregister lifecycle
// ---------------------------------------------------------------------------
let registration: vscode.Disposable | undefined;

export function registerMockDebugAdapter(): void {
  registration = vscode.debug.registerDebugAdapterDescriptorFactory('xdebug-mcp-test', {
    createDebugAdapterDescriptor(
      _session: vscode.DebugSession,
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
      return new vscode.DebugAdapterInlineImplementation(new MockDebugAdapter());
    },
  });
}

export function unregisterMockDebugAdapter(): void {
  registration?.dispose();
  registration = undefined;
}

// ---------------------------------------------------------------------------
// MockDebugAdapter
// ---------------------------------------------------------------------------
class MockDebugAdapter implements vscode.DebugAdapter {
  // ---- public interface ------------------------------------------------
  private _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._onDidSendMessage.event;

  // ---- session state --------------------------------------------------
  private isRunning = true; // true = running, false = stopped at breakpoint/step/pause
  private threadId = 1;
  private fileBreakpoints: Array<{ line: number; source?: { name?: string; path?: string } }> =
    [];
  private functionBreakpoints: Array<{ name: string }> = [];
  private terminated = false;
  private disposed = false;
  private configDoneTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- breakpoint ID counters -----------------------------------------
  private nextBpId = 1;
  private nextFuncBpId = 1;

  // ====================================================================
  //  handleMessage – main DAP dispatch
  // ====================================================================
  handleMessage(message: vscode.DebugProtocolMessage): void {
    if (this.disposed) {
      return;
    }

    const request = message as unknown as DapRequest;

    switch (request.command) {
      // ----------------------------------------------------------------
      // LIFECYCLE
      // ----------------------------------------------------------------
      case 'initialize':
        return this.handleInitialize(request);
      case 'launch':
        return this._sendResponse(request, {});
      case 'attach':
        return this._sendResponse(request, {});
      case 'disconnect':
        return this.handleDisconnect(request);

      // ----------------------------------------------------------------
      // BREAKPOINTS
      // ----------------------------------------------------------------
      case 'setBreakpoints':
        return this.handleSetBreakpoints(request);
      case 'setFunctionBreakpoints':
        return this.handleSetFunctionBreakpoints(request);
      case 'setExceptionBreakpoints':
        return this._sendResponse(request, {});

      // ----------------------------------------------------------------
      // CONFIGURATION DONE
      // ----------------------------------------------------------------
      case 'configurationDone':
        return this.handleConfigurationDone(request);

      // ----------------------------------------------------------------
      // INSPECTION
      // ----------------------------------------------------------------
      case 'threads':
        return this.handleThreads(request);
      case 'stackTrace':
        return this.handleStackTrace(request);
      case 'scopes':
        return this.handleScopes(request);
      case 'variables':
        return this.handleVariables(request);
      case 'evaluate':
        return this.handleEvaluate(request);

      // ----------------------------------------------------------------
      // EXECUTION CONTROL
      // ----------------------------------------------------------------
      case 'continue':
        return this.handleContinue(request);
      case 'next':
        return this.handleStep(request, 'next');
      case 'stepIn':
        return this.handleStep(request, 'stepIn');
      case 'stepOut':
        return this.handleStep(request, 'stepOut');
      case 'pause':
        return this.handlePause(request);
      case 'restart':
        return this.handleRestart(request);
      case 'terminate':
        return this.handleTerminate(request);

      // ----------------------------------------------------------------
      // UNKNOWN
      // ----------------------------------------------------------------
      default:
        this._sendErrorResponse(request, `Unsupported command: ${request.command}`);
    }
  }

  // ====================================================================
  //  dispose
  // ====================================================================
  dispose(): void {
    if (this.configDoneTimer) {
      clearTimeout(this.configDoneTimer);
      this.configDoneTimer = undefined;
    }
    this.disposed = true;
    this._onDidSendMessage.dispose();
  }

  // ====================================================================
  //  PRIVATE – response / event helpers
  // ====================================================================
  private _sendResponse(request: DapRequest, body?: unknown): void {
    this._onDidSendMessage.fire({
      type: 'response',
      seq: 0,
      request_seq: request.seq,
      command: request.command,
      success: true,
      body,
    } as vscode.DebugProtocolMessage);
  }

  private _sendErrorResponse(request: DapRequest, message: string): void {
    this._onDidSendMessage.fire({
      type: 'response',
      seq: 0,
      request_seq: request.seq,
      command: request.command,
      success: false,
      message,
    } as vscode.DebugProtocolMessage);
  }

  private _fireEvent(event: string, body?: unknown): void {
    this._onDidSendMessage.fire({
      type: 'event',
      seq: 0,
      event,
      body,
    } as vscode.DebugProtocolMessage);
  }

  // ====================================================================
  //  HANDLERS
  // ====================================================================

  // --- initialize ----------------------------------------------------
  private handleInitialize(request: DapRequest): void {
    this._sendResponse(request, {
      supportsConfigurationDoneRequest: true,
      supportsStepIn: true,
      supportsEvaluate: true,
      supportsRestartRequest: true,
      supportsTerminateRequest: true,
      supportsDisconnectRequest: true,
      supportsSetVariable: false,
      supportsConditionalBreakpoints: false,
      supportsHitConditionalBreakpoints: false,
      supportsLogPoints: true,
      supportsFunctionBreakpoints: true,
      supportsExceptionFilterOptions: true,
      supportsStepBack: false,
    });
  }

  // --- setBreakpoints -------------------------------------------------
  private handleSetBreakpoints(request: DapRequest): void {
    const args = request.arguments ?? {};
    const source = (args as any).source;
    const lines = (args as any).breakpoints as Array<{ line: number }> | undefined;

    const bpList = (lines ?? []).map((bp) => {
      const entry = { line: bp.line, source };
      this.fileBreakpoints.push(entry);
      return {
        id: this.nextBpId++,
        verified: true,
        line: bp.line,
        source,
      };
    });

    this._sendResponse(request, { breakpoints: bpList });
  }

  // --- setFunctionBreakpoints -----------------------------------------
  private handleSetFunctionBreakpoints(request: DapRequest): void {
    const args = request.arguments ?? {};
    const names = (args as any).breakpoints as Array<{ name: string }> | undefined;

    const bpList = (names ?? []).map((bp) => {
      this.functionBreakpoints.push(bp);
      return {
        id: this.nextFuncBpId++,
        verified: true,
        name: bp.name,
      };
    });

    this._sendResponse(request, { breakpoints: bpList });
  }

  // --- configurationDone ----------------------------------------------
  private handleConfigurationDone(request: DapRequest): void {
    this._sendResponse(request, {});
    this.configDoneTimer = setTimeout(() => {
      if (this.disposed) {
        return;
      }
      this.isRunning = false;
      this.terminated = false;
      this._fireEvent('stopped', {
        reason: 'breakpoint',
        threadId: this.threadId,
        allThreadsStopped: true,
      });
    }, 100);
  }

  // --- threads --------------------------------------------------------
  private handleThreads(request: DapRequest): void {
    this._sendResponse(request, {
      threads: [{ id: this.threadId, name: 'Main Thread' }],
    });
  }

  // --- stackTrace -----------------------------------------------------
  private handleStackTrace(request: DapRequest): void {
    this._sendResponse(request, {
      stackFrames: [
        {
          id: 0,
          name: 'index.php:10',
          source: {
            name: 'index.php',
            path: '/home/user/test-workspace/index.php',
          },
          line: 10,
          column: 1,
        },
        {
          id: 1,
          name: 'helper',
          source: {
            name: 'helper.php',
            path: '/home/user/test-workspace/helper.php',
          },
          line: 5,
          column: 1,
        },
        {
          id: 2,
          name: '{main}',
          source: {
            name: 'index.php',
            path: '/home/user/test-workspace/index.php',
          },
          line: 1,
          column: 1,
        },
      ],
    });
  }

  // --- scopes ---------------------------------------------------------
  private handleScopes(request: DapRequest): void {
    this._sendResponse(request, {
      scopes: [
        {
          name: 'Locals',
          variablesReference: 100,
          expensive: false,
          namedVariables: 3,
        },
      ],
    });
  }

  // --- variables ------------------------------------------------------
  private handleVariables(request: DapRequest): void {
    const args = request.arguments ?? {};
    const variablesReference = (args as any).variablesReference as number;

    // Known top-level scope
    if (variablesReference === 100) {
      return this._sendResponse(request, {
        variables: [
          {
            name: 'str',
            value: 'hello',
            type: 'string',
            variablesReference: 0,
          },
          {
            name: 'num',
            value: '42',
            type: 'int',
            variablesReference: 0,
          },
          {
            name: 'arr',
            value: '[1,2,3]',
            type: 'array',
            variablesReference: 200,
            indexedVariables: 3,
          },
          {
            name: 'obj',
            value: '{...}',
            type: 'object',
            variablesReference: 0,
          },
        ],
      });
    }

    // Array child expansion
    if (variablesReference === 200) {
      return this._sendResponse(request, {
        variables: [
          { name: '[0]', value: '1', variablesReference: 0 },
          { name: '[1]', value: '2', variablesReference: 0 },
          { name: '[2]', value: '3', variablesReference: 0 },
        ],
      });
    }

    // Unknown reference – spec says send error
    return this._sendErrorResponse(request, `Unknown variablesReference: ${variablesReference}`);
  }

  // --- evaluate -------------------------------------------------------
  private handleEvaluate(request: DapRequest): void {
    const args = (request.arguments ?? {}) as {
      expression?: string;
      context?: string;
      frameId?: number;
    };

    const expression = args.expression ?? '';

    try {
      // eslint-disable-next-line no-eval
      const value = eval(expression);
      let result = String(value);
      if (args.context === 'watch') {
        result = `[watch] ${result}`;
      }
      this._sendResponse(request, { result, variablesReference: 0 });
    } catch {
      this._sendErrorResponse(request, 'Error evaluating expression');
    }
  }

  // --- continue -------------------------------------------------------
  private handleContinue(request: DapRequest): void {
    this.isRunning = true;
    // Send response first so the caller doesn't see an error from a
    // session that hasn't been terminated yet.
    this._sendResponse(request, { allThreadsContinued: true });
    this._fireEvent('terminated', { threadId: this.threadId });
    this.terminated = true;
  }

  // --- step commands (next / stepIn / stepOut) ------------------------
  private handleStep(request: DapRequest, cmd: string): void {
    this.isRunning = false;
    this.terminated = false;
    this._fireEvent('stopped', { reason: 'step', threadId: this.threadId });
    this._sendResponse(request, {});
  }

  // --- pause ----------------------------------------------------------
  private handlePause(request: DapRequest): void {
    this.isRunning = false;
    this.terminated = false;
    this._fireEvent('stopped', { reason: 'pause', threadId: this.threadId });
    this._sendResponse(request, {});
  }

  // --- restart --------------------------------------------------------
  // Reset state with a new threadId, fire a stopped event (breakpoint),
  // but do NOT fire terminated first.
  private handleRestart(request: DapRequest): void {
    this.threadId++;
    this.isRunning = false;
    this.terminated = false;
    this.nextBpId = 1;
    this.nextFuncBpId = 1;
    this.fileBreakpoints = [];
    this.functionBreakpoints = [];
    this._fireEvent('stopped', {
      reason: 'breakpoint',
      threadId: this.threadId,
      allThreadsStopped: true,
    });
    this._sendResponse(request, {});
  }

  // --- terminate ------------------------------------------------------
  private handleTerminate(request: DapRequest): void {
    this.isRunning = true;
    // Send response first so the caller doesn't see an error from a
    // session that hasn't been terminated yet.
    this._sendResponse(request, {});
    this._fireEvent('terminated', { threadId: this.threadId });
    this.terminated = true;
  }

  // --- disconnect -----------------------------------------------------
  private handleDisconnect(request: DapRequest): void {
    this.isRunning = true;
    // Send response first so the caller doesn't see an error from a
    // session that hasn't been terminated yet.
    this._sendResponse(request, {});
    if (!this.terminated) {
      this._fireEvent('terminated', { threadId: this.threadId });
      this.terminated = true;
    }
  }
}
