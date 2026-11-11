import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function connect(t, toolset) {
  const client = new Client({ name: 'code-mode-test', version: '1.0.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === 'string'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server.mjs', import.meta.url))], env: { ...env, REVIT_BRIDGE_TOOLSET: toolset }, stderr: 'pipe' });
  t.after(() => client.close()); await client.connect(transport); return client;
}

test('Default MCP surface discovers operations and executes JS through stdio', async t => {
  const client = await connect(t, 'code');
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['revit_code_mode','revit_tools']);
  const search = JSON.parse((await client.callTool({ name: 'revit_tools', arguments: { query: 'revit_query' } })).content[0].text);
  assert.equal(search.total, 1); assert.ok(search.operations[0].inputSchema.required.includes('documentId'));
  assert.equal(search.operations[0].inputSchema.properties.code.type, 'string');
  const all = JSON.parse((await client.callTool({ name: 'revit_tools', arguments: { limit: 28 } })).content[0].text);
  assert.equal(all.total, 28);
  const result = await client.callTool({ name: 'revit_code_mode', arguments: { code: 'const s=await revit.call("revit_sessions",{}); return {count:s.length};' } });
  assert.ok(!result.isError); const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, 'completed'); assert.equal(typeof data.value.count, 'number');
  const bad = await client.callTool({ name: 'revit_code_mode', arguments: { code: 'throw new Error("failed script");' } });
  assert.equal(bad.isError, true);
});

test('Full MCP surface retains the original 28 operations plus Code Mode', async t => {
  const client = await connect(t, 'full');
  const names = (await client.listTools()).tools.map(t => t.name);
  assert.equal(names.length, 30); assert.ok(names.includes('revit_execute_code')); assert.ok(names.includes('revit_code_mode'));
});
