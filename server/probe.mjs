import { loadConfig } from './config.mjs';
// Full MCP client for testing and for use before Codex reloads its tool list.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './core.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const config = await loadConfig(root);
const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const client = new Client({ name: 'revit-workspace-probe', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server.mjs')], stderr: 'inherit' });
try {
  await client.connect(transport);
  const tool = process.argv[2];
  const args = process.argv[3] ? await readJson(path.resolve(process.argv[3])) : {};
  const result = !tool || tool === '--list' ? await client.listTools() : await client.callTool({ name: tool, arguments: args });
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
