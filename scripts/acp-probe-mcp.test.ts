import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./acp-probe-mcp.ts', import.meta.url));
const tool = 'mcp__pi__offload_probe';
const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (id: number) => request(id, 'tools/call', { name: tool, arguments: {} });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'acp-probe-mcp-'));
  const audit = join(directory, 'audit.jsonl');
  writeFileSync(audit, '', { mode: 0o600 });
  return { directory, audit, args: (bytes = 256) => ['--bytes', String(bytes), '--audit', audit] };
}

async function run(args: string[], messages: unknown[], onOutput?: (chunk: Buffer) => void) {
  const child = spawn(process.execPath, ['--experimental-transform-types', script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputError: unknown;
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
    try { onOutput?.(chunk); } catch (error) { outputError = error; }
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  // Early CLI rejection may close the pipe before its input is consumed.
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') outputError = error;
  });
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.end(messages.map(message => typeof message === 'string' ? message : JSON.stringify(message)).join('\n') + (messages.length ? '\n' : ''));
    const code = await closed;
    if (outputError) throw outputError;
    const text = Buffer.concat(stdout).toString();
    return { code, text, messages: text.trim() ? text.trim().split('\n').map((line: string) => JSON.parse(line)) : [], stderr: Buffer.concat(stderr).toString() };
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

const readAudit = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('stdio handshake, discovery, ping and silent notifications do not mint receipts', async t => {
  const cases = [
    {
      name: 'handshake and discovery',
      input: [request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } }), { jsonrpc: '2.0', method: 'notifications/initialized' }, request(2, 'tools/list'), request(3, 'ping')],
      verify: (messages: any[]) => {
        assert.deepEqual(messages.map(message => message.id), [1, 2, 3]);
        assert.deepEqual(messages[0].result, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'acp-probe-mcp', version: '1.0.0' } });
        assert.deepEqual(messages[1].result.tools, [{ name: tool, description: 'Return a diagnostic ASCII payload with a fresh receipt.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]);
        assert.deepEqual(messages[2].result, {});
        assert.ok(messages.every(message => message.jsonrpc === '2.0' && !message.error));
      },
    },
    {
      name: 'notifications only, including calls, produce no output or audit',
      input: [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'tools/call', params: { name: tool, arguments: {} } }, { jsonrpc: '2.0', method: 'unknown' }],
      verify: (messages: any[]) => assert.deepEqual(messages, []),
    },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const f = fixture();
    try {
      const result = await run(f.args(), row.input);
      assert.equal(result.code, 0, result.stderr);
      row.verify(result.messages);
      assert.equal(readFileSync(f.audit, 'utf8'), '');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
});

test('real calls return bounded ASCII and independently audited receipts before replies', async t => {
  for (const bytes of [64, 128, 4096, 4194304]) await t.test(`${bytes} bytes`, async () => {
    const f = fixture();
    try {
      assert.deepEqual(readAudit(f.audit), []);
      let pending = '';
      const result = await run(f.args(bytes), [call(1), call(2)], chunk => {
        assert.ok(readAudit(f.audit).length >= 1);
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const response = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          const entry = readAudit(f.audit)[response.id - 1];
          assert.ok(entry, 'each audit entry must exist when its reply arrives');
          assert.ok(response.result.content[0].text.endsWith(`TAIL_RECEIPT=${entry.receipt}`));
        }
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.messages.length, 2);
      const entries = readAudit(f.audit);
      assert.equal(entries.length, 2);
      assert.notEqual(entries[0].receipt, entries[1].receipt);
      for (const [index, entry] of entries.entries()) {
        const response = result.messages[index];
        assert.equal(response.id, index + 1);
        assert.equal(response.jsonrpc, '2.0');
        assert.deepEqual(Object.keys(response.result), ['content']);
        assert.equal(response.result.content.length, 1);
        assert.equal(response.result.content[0].type, 'text');
        const text: string = response.result.content[0].text;
        assert.match(text, /^[\x20-\x7e\n]+$/);
        assert.match(entry.receipt, /^[a-f0-9]{64}$/);
        assert.match(text, /^RESULT_ID=[a-f0-9]{32}\n/);
        assert.equal(text.slice(0, text.lastIndexOf('TAIL_RECEIPT=')).includes(entry.receipt), false, 'receipt must not leak before the tail');
        assert.ok(text.endsWith(`TAIL_RECEIPT=${entry.receipt}`));
        assert.ok(text.length >= bytes && text.length <= bytes + 256);
        assert.ok(text.split('\n').slice(1, -1).every(line => line.length === 127));
        assert.deepEqual(entry, { tool, arguments: {}, receipt: entry.receipt, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), lines: text.split('\n').length });
      }
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
});

test('retries are observable but bulk response amplification is bounded', async () => {
  const f = fixture();
  try {
    const result = await run(f.args(), [call(1), call(2), call(3), call(4)]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readAudit(f.audit).length, 2);
    assert.deepEqual(result.messages.slice(2).map(message => message.error.code), [-32000, -32000]);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('standard optional call fields do not block the data source', async t => {
  for (const row of [
    { name: 'omitted empty arguments', params: { name: tool } },
    { name: 'protocol metadata', params: { name: tool, arguments: {}, _meta: { progressToken: 'probe' } } },
  ]) await t.test(row.name, async () => {
    const f = fixture();
    try {
      const result = await run(f.args(), [request(1, 'tools/call', row.params)]);
      assert.equal(result.code, 0, result.stderr);
      const entries = readAudit(f.audit);
      assert.equal(entries.length, 1);
      assert.ok(result.messages[0].result.content[0].text.endsWith(`TAIL_RECEIPT=${entries[0].receipt}`));
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
});

test('malformed requests and invalid calls return JSON-RPC errors without auditing', async t => {
  const cases = [
    { name: 'parse error', input: '{', code: -32700, id: null },
    { name: 'batch unsupported', input: [], code: -32600, id: null },
    { name: 'wrong version', input: { jsonrpc: '1.0', id: 1, method: 'ping' }, code: -32600, id: 1 },
    { name: 'invalid id', input: { jsonrpc: '2.0', id: {}, method: 'ping' }, code: -32600, id: null },
    { name: 'unknown method', input: request(1, 'unknown'), code: -32601, id: 1 },
    { name: 'bad initialize', input: request(1, 'initialize', {}), code: -32602, id: 1 },
    { name: 'array params', input: request(1, 'tools/call', []), code: -32602, id: 1 },
    { name: 'missing params', input: request(1, 'tools/call'), code: -32602, id: 1 },
    ...[
      { name: 'wrong tool', params: { name: 'offload_probe', arguments: {} } },
      { name: 'null arguments', params: { name: tool, arguments: null } },
      { name: 'array arguments', params: { name: tool, arguments: [] } },
      { name: 'extra arguments', params: { name: tool, arguments: { bytes: 64 } } },
      { name: 'extra params', params: { name: tool, arguments: {}, extra: true } },
      { name: 'invalid metadata', params: { name: tool, arguments: {}, _meta: 'invalid' } },
    ].map(row => ({ name: row.name, input: request(1, 'tools/call', row.params), code: -32602, id: 1 })),
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const f = fixture();
    try {
      const result = await run(f.args(), [row.input]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.messages.length, 1);
      assert.deepEqual(result.messages[0], { jsonrpc: '2.0', id: row.id, error: { code: row.code, message: result.messages[0].error.message } });
      assert.equal(typeof result.messages[0].error.message, 'string');
      assert.equal(readFileSync(f.audit, 'utf8'), '');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
});

test('CLI gates reject unsafe paths and malformed flags without writes', async t => {
  const cases: { name: string; args: (f: ReturnType<typeof fixture>) => string[] }[] = [
    ...['63', '4194305', '1.5', '-64', 'NaN', '1e3', '64x', ''].map(bytes => ({ name: `invalid bytes ${bytes}`, args: (f: ReturnType<typeof fixture>) => ['--bytes', bytes, '--audit', f.audit] })),
    { name: 'unknown flag', args: f => [...f.args(), '--unknown', 'x'] },
    { name: 'duplicate flag', args: f => [...f.args(), '--bytes', '64'] },
    { name: 'missing value', args: f => [...f.args(), '--audit'] },
    { name: 'missing bytes', args: f => ['--audit', f.audit] },
    { name: 'missing audit', args: () => ['--bytes', '64'] },
    { name: 'relative path', args: () => ['--bytes', '64', '--audit', 'audit.jsonl'] },
    { name: 'non-temp path', args: () => ['--bytes', '64', '--audit', script] },
    { name: 'missing file is not created', args: f => ['--bytes', '64', '--audit', join(f.directory, 'missing')] },
    { name: 'public file', args: f => { chmodSync(f.audit, 0o644); return f.args(); } },
    { name: 'symlink', args: f => { const link = join(f.directory, 'link'); symlinkSync(f.audit, link); return ['--bytes', '64', '--audit', link]; } },
    { name: 'directory', args: f => ['--bytes', '64', '--audit', f.directory] },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const f = fixture();
    try {
      writeFileSync(f.audit, 'unchanged\n');
      const result = await run(row.args(f), [call(1)]);
      assert.equal(result.code, 1);
      assert.equal(result.text, '');
      assert.ok(result.stderr.length > 0);
      assert.equal(readFileSync(f.audit, 'utf8'), 'unchanged\n');
      assert.equal(existsSync(join(f.directory, 'missing')), false);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
});

test('oversized input is rejected without a tool invocation', async () => {
  const f = fixture();
  try {
    const result = await run(f.args(), ['x'.repeat(16385)]);
    assert.equal(result.code, 1);
    assert.equal(result.text, '');
    assert.match(result.stderr, /Request line exceeds/);
    assert.equal(readFileSync(f.audit, 'utf8'), '');
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
