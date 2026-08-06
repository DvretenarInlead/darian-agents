import { describe, it, expect, afterAll } from 'vitest';
import { McpStdioClient } from './mcpStdioClient.js';

/**
 * Fake stdio MCP server: newline-delimited JSON-RPC. Handles initialize,
 * echoes tools/call with a canned per-tool payload, and marks the tool
 * 'boom' as isError.
 */
const FAKE_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }) + '\\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params.name;
    if (name === 'boom') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'kaput' }] } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ tool: name, args: msg.params.arguments }) }] } }) + '\\n');
    }
  }
});
`;

const client = new McpStdioClient({
  command: process.execPath,
  args: ['-e', FAKE_SERVER],
  name: 'fake-mcp',
  callTimeoutMs: 5_000,
});

afterAll(() => client.stop());

describe('McpStdioClient', () => {
  it('initializes once and round-trips tool calls', async () => {
    const text = await client.callTool('echo', { a: 1 });
    expect(JSON.parse(text)).toEqual({ tool: 'echo', args: { a: 1 } });

    // Second call reuses the same child (still answers).
    const again = await client.callTool('echo', { b: 2 });
    expect(JSON.parse(again).args).toEqual({ b: 2 });
  });

  it('throws on isError tool results with the server message', async () => {
    await expect(client.callTool('boom', {})).rejects.toThrow(/kaput/);
  });
});
