#!/usr/bin/env node
// Zero-dependency MCP stdio JSON-RPC 2.0 server for Antigravity–Codex Bridge.
// Performs version-agnostic MCP capability negotiation and enforces bounded buffering.
import fs from 'node:fs';
import { debuglog } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CALL_DEADLINE_MS, startCall } from '../lib/core/call-time.mjs';
import { errorOutcome } from '../lib/core/outcome.mjs';
import { createBridgeService } from '../lib/service/bridge-service.mjs';
import { detectHostApp } from '../lib/service/caller-identity.mjs';

const SUPPORTED_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_OUTSTANDING = 32;

const TOOL_DEFINITIONS = [
  {
    name: 'list_codex_threads',
    host: 'antigravity',
    description: 'List local Codex threads with their exact thread_id, title, status, cwd, and discovery source.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_antigravity_conversations',
    host: 'codex',
    description:
      'List local Antigravity conversations with their exact conversation_id, title, summary, run_state, and project_id.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        include_archived: { type: 'boolean', default: false },
        include_subagents: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_codex',
    host: 'antigravity',
    description: 'Send an asynchronous peer message to a specific Codex thread_id.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 128 },
        message: { type: 'string', minLength: 1, maxLength: 65536 },
        transport: { type: 'string', enum: ['auto', 'daemon', 'desktop', 'queue'], default: 'auto' },
        wait_if_busy: { type: 'boolean', default: false, description: 'If true, refuse active turns instead of steering.' },
        message_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
        retry_failed: { type: 'boolean', default: false },
        include_message: { type: 'boolean', default: true },
      },
      required: ['thread_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_antigravity',
    host: 'codex',
    description: 'Send an asynchronous peer message to a specific Antigravity conversation_id.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', minLength: 1, maxLength: 128 },
        message: { type: 'string', minLength: 1, maxLength: 65536 },
        title: { type: 'string', maxLength: 120 },
        message_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
        retry_failed: { type: 'boolean', default: false },
        include_message: { type: 'boolean', default: true },
      },
      required: ['conversation_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_deliveries',
    host: 'both',
    description: 'Inspect outgoing bridge delivery records for the current conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_doctor',
    host: 'both',
    description: 'Diagnose Antigravity and Codex bridge connectivity, caller identity, and local transports without sending.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function visibleTools(hostApp) {
  return TOOL_DEFINITIONS.filter(tool => !hostApp || tool.host === 'both' || tool.host === hostApp).map(
    ({ host: _host, ...publicDef }) => publicDef,
  );
}

function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_MCP_VERSIONS.includes(requested)) {
    return requested;
  }
  return SUPPORTED_MCP_VERSIONS[0];
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

export async function runMcpServer({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  service = createBridgeService({ env }),
} = {}) {
  const hostApp = detectHostApp({ env });
  const inFlight = new Map();
  let buffer = Buffer.alloc(0);
  let stopped = false;

  await service.refreshOwnRegistration().catch(() => {});

  const writeMessage = msg => {
    if (stopped || output.destroyed || output.writableEnded) return;
    output.write(`${JSON.stringify(msg)}\n`);
  };

  async function handleRequest(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      writeMessage(rpcError(null, -32600, 'Invalid JSON-RPC request.'));
      return;
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined;

    if (method === 'notifications/initialized') return;
    if (method === 'notifications/cancelled') {
      const targetId = params?.requestId;
      const call = inFlight.get(targetId);
      call?.cancel();
      return;
    }

    if (isNotification) return;

    if (method === 'initialize') {
      const protocolVersion = negotiateProtocolVersion(params?.protocolVersion);
      writeMessage(
        rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'antigravity-codex-bridge', version: 'bridge' },
        }),
      );
      return;
    }

    if (method === 'ping') {
      writeMessage(rpcResult(id, {}));
      return;
    }

    if (method === 'tools/list') {
      writeMessage(rpcResult(id, { tools: visibleTools(hostApp) }));
      return;
    }

    if (method === 'tools/call') {
      if (inFlight.size >= MAX_OUTSTANDING) {
        writeMessage(
          rpcResult(id, {
            isError: true,
            content: [{ type: 'text', text: 'Bridge server queue is full. Wait for an in-flight call to complete.' }],
          }),
        );
        return;
      }

      const name = params?.name;
      const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const metadata = params?._meta && typeof params._meta === 'object' ? params._meta : {};
      const call = startCall({ budgetMs: CALL_DEADLINE_MS });
      inFlight.set(id, call);

      try {
        const result = await service.executeTool(name, toolArgs, { metadata, signal: call.signal });
        writeMessage(
          rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          }),
        );
      } catch (error) {
        const out = errorOutcome(error);
        writeMessage(
          rpcResult(id, {
            isError: true,
            content: [
              { type: 'text', text: error?.message || 'Bridge tool execution failed.' },
              { type: 'text', text: JSON.stringify(out) },
            ],
            _meta: { 'antigravity-codex-bridge/outcome': out },
          }),
        );
      } finally {
        call.dispose();
        inFlight.delete(id);
      }
      return;
    }

    writeMessage(rpcError(id, -32601, `Method not found: ${method}`));
  }

  return new Promise(resolve => {
    let inputEnded = false;
    let pendingHandlers = 0;

    function maybeFinish() {
      if (inputEnded && pendingHandlers === 0 && inFlight.size === 0) {
        stop(false);
      }
    }

    function stop(abortInFlight = true) {
      if (stopped) return;
      stopped = true;
      if (abortInFlight) {
        for (const call of inFlight.values()) call.cancel();
        inFlight.clear();
      }
      resolve();
    }

    input.on('data', chunk => {
      if (stopped) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      let nl;
      while ((nl = buffer.indexOf(0x0a)) !== -1) {
        const raw = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        if (raw.length > MAX_LINE_BYTES) {
          writeMessage(rpcError(null, -32700, 'MCP line exceeds size limit.'));
          continue;
        }
        const line = raw.toString('utf8').replace(/\r$/, '').trim();
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          writeMessage(rpcError(null, -32700, 'Parse error: invalid JSON.'));
          continue;
        }
        pendingHandlers++;
        handleRequest(parsed)
          .catch(err => {
            writeMessage(rpcError(parsed?.id ?? null, -32603, err?.message || 'Internal server error.'));
          })
          .finally(() => {
            pendingHandlers--;
            maybeFinish();
          });
      }
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = Buffer.alloc(0);
        writeMessage(rpcError(null, -32700, 'MCP frame exceeds size limit.'));
      }
    });

    input.on('end', () => {
      inputEnded = true;
      maybeFinish();
    });
    input.on('error', () => stop(true));
    output.on('close', () => stop(true));
    output.on('error', () => stop(true));
    process.once('SIGINT', () => stop(true));
    process.once('SIGTERM', () => stop(true));
  });
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  if (debuglog('child_process').enabled) {
    process.stderr.write(
      'Antigravity–Codex Bridge refused to start: disable NODE_DEBUG=child_process to prevent logging message text.\n',
    );
    process.exitCode = 1;
  } else {
    await runMcpServer();
  }
}
