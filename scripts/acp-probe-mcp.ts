import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const tool = 'mcp__pi__offload_probe';
let executions = 0;

function parseOptions(args: string[]): { bytes: number; audit: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag !== '--bytes' && flag !== '--audit') || value === undefined || values.has(flag)) {
      throw new Error('Expected --bytes <integer> --audit <absolute private temp file>');
    }
    values.set(flag, value);
  }

  const size = values.get('--bytes') ?? '';
  const audit = values.get('--audit') ?? '';
  const bytes = Number(size);
  if (!/^[0-9]+$/.test(size) || !Number.isSafeInteger(bytes) || bytes < 64 || bytes > 4194304 || !isAbsolute(audit)) {
    throw new Error('Invalid --bytes or --audit');
  }
  return { bytes, audit };
}

function openAudit(path: string): number {
  const parent = realpathSync(dirname(path));
  const withinTemp = relative(realpathSync(tmpdir()), parent);
  if (isAbsolute(withinTemp) || withinTemp === '..' || withinTemp.startsWith(`..${sep}`)) {
    throw new Error('Audit must be in the OS temporary directory');
  }

  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error('Audit must be an existing private, current-user-owned regular file');
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function handle(line: string, bytes: number, audit: number): object | undefined {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }

  const validId = isObject(request) && (typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id)) || request.id === null);
  const id = validId && isObject(request) ? request.id : null;
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || ('id' in request && !validId)) {
    return error(-32600, 'Invalid Request');
  }
  // Notifications never produce output or invoke the diagnostic tool.
  if (!('id' in request)) return undefined;
  if ('params' in request && !isObject(request.params)) return error(-32602, 'Invalid params');

  let result: unknown;
  switch (request.method) {
    case 'initialize':
      if (!isObject(request.params) || typeof request.params.protocolVersion !== 'string' || !isObject(request.params.capabilities) || !isObject(request.params.clientInfo)) {
        return error(-32602, 'Invalid initialize params');
      }
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'acp-probe-mcp', version: '1.0.0' } };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: [{ name: tool, description: 'Return a diagnostic ASCII payload with a fresh receipt.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      break;
    case 'tools/call': {
      const params = request.params;
      if (!isObject(params) || params.name !== tool ||
          (params.arguments !== undefined && (!isObject(params.arguments) || Object.keys(params.arguments).length !== 0)) ||
          (params._meta !== undefined && !isObject(params._meta)) ||
          Object.keys(params).some(key => key !== 'name' && key !== 'arguments' && key !== '_meta')) {
        return error(-32602, 'Unknown tool or invalid arguments');
      }

      // One retry remains observable in the audit; further calls cannot amplify
      // a 4 MiB payload while the diagnostic waits for the prompt deadline.
      if (++executions > 2) return error(-32000, 'Probe call budget exceeded');
      const receipt = randomBytes(32).toString('hex');
      // The receipt must exist only at the tail, never in the first page's header.
      const header = `RESULT_ID=${randomBytes(16).toString('hex')}\n`;
      const tail = `TAIL_RECEIPT=${receipt}`;
      const filler = '0123456789abcdef'.repeat(7) + '0123456789abcde\n';
      const count = Math.max(0, Math.ceil((bytes - header.length - tail.length) / filler.length));
      const text = header + filler.repeat(count) + tail;
      const entry = { tool, arguments: {}, receipt, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), lines: text.split('\n').length };
      const record = Buffer.from(JSON.stringify(entry) + '\n');
      let written = 0;
      while (written < record.length) written += writeSync(audit, record, written);

      result = { content: [{ type: 'text', text }] };
      break;
    }
    default:
      return error(-32601, 'Method not found');
  }
  return { jsonrpc: '2.0', id, result };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const audit = openAudit(options.audit);
  let lineBytes = 0;
  // Bound request buffering before readline can accumulate an unterminated line.
  process.stdin.on('data', (chunk: Buffer) => {
    for (const byte of chunk) {
      lineBytes = byte === 10 ? 0 : lineBytes + 1;
      if (lineBytes > 16384) {
        process.stderr.write('Request line exceeds 16384 bytes\n');
        process.exit(1);
      }
    }
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      const response = handle(line, options.bytes, audit);
      if (response !== undefined && !process.stdout.write(JSON.stringify(response) + '\n')) {
        await once(process.stdout, 'drain');
      }
    }
  } finally {
    input.close();
    closeSync(audit);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Probe failed'}\n`);
  process.exitCode = 1;
});
