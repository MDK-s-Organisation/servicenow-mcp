// End to end tests for server.mjs. Run with: node test/run-tests.mjs
// Everything runs against the local mock. The real instance is never contacted,
// no browser is opened, and the token and config files live in a temp folder.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startMock } from './mock-servicenow.mjs';

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const SERVER = path.join(HERE, '..', 'server.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'servicenow-mcp-test-'));
const FAKE_HOME = path.join(ROOT, 'home');
const STUB_BIN = path.join(ROOT, 'bin');
const OPEN_MARK = path.join(ROOT, 'open-called.txt');
fs.mkdirSync(FAKE_HOME);
fs.mkdirSync(STUB_BIN);
// A fake "open" command. Child processes get a PATH with only this folder,
// so the real one can never start a browser during the tests.
fs.writeFileSync(path.join(STUB_BIN, 'open'), `#!/bin/sh\nprintf '%s' "$1" > "${OPEN_MARK}"\n`, { mode: 0o755 });

const mock = await startMock();
const S = mock.state;
const outputs = []; // everything any child process printed, for the leak check
const clients = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = (file) => fs.statSync(file).mode & 0o777;
const sha256url = (text) => crypto.createHash('sha256').update(text).digest('base64url');
const lastRequest = () => S.requests[S.requests.length - 1];

function withTimeout(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function envFor(dir, extra = {}) {
  const env = {
    PATH: STUB_BIN, HOME: FAKE_HOME, SN_INSTANCE: mock.url, SN_CLIENT_ID: S.clientId,
    SN_TOKEN_FILE: path.join(dir, 'tokens.json'), SN_CONFIG_FILE: path.join(dir, 'config.json'), ...extra,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// Start a CLI command. Returns the live record and a promise for the exit.
function startCli(args, env) {
  const proc = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { label: args.join(' '), stdout: '', stderr: '', code: null };
  outputs.push(rec);
  proc.stdout.on('data', (chunk) => { rec.stdout += chunk; });
  proc.stderr.on('data', (chunk) => { rec.stderr += chunk; });
  const done = withTimeout(new Promise((resolve) => proc.on('close', (code) => { rec.code = code; resolve(rec); })), 20000, `exit of ${rec.label}`);
  return { rec, done, proc };
}
const runCli = (args, env) => startCli(args, env).done;

async function printedUrl(rec) {
  for (let i = 0; i < 200; i += 1) {
    const found = /^(http:\/\/127\.0\.0\.1:\d+\/oauth_auth\.do\?\S+)$/m.exec(rec.stdout);
    if (found) return found[1];
    if (rec.code !== null) break;
    await sleep(25);
  }
  throw new Error(`login did not print an authorization URL. stderr: ${rec.stderr}`);
}

// The test plays the browser: open the printed URL, follow the redirect.
async function browse(url) {
  const first = await fetch(url, { redirect: 'manual' });
  assert.equal(first.status, 302, 'the mock should redirect back to the callback');
  const location = first.headers.get('location');
  const page = await fetch(location);
  const html = await page.text();
  outputs.push({ label: 'callback page', stdout: html, stderr: '' });
  return { location, status: page.status, html };
}

async function login(dir, extraArgs = ['--no-open'], extraEnv = {}) {
  const port = await freePort();
  const cli = startCli(['login', '--port', String(port), ...extraArgs], envFor(dir, extraEnv));
  const url = await printedUrl(cli.rec);
  return { port, url, cli };
}

async function signIn(dir) {
  const { port, url, cli } = await login(dir);
  const page = await browse(url);
  const rec = await cli.done;
  assert.equal(rec.code, 0, `login failed: ${rec.stderr}`);
  return { port, url, page, rec };
}

// A tiny MCP client that talks JSON-RPC to the server over stdio.
class Mcp {
  constructor(env, label = 'serve') {
    this.proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.rec = { label, stdout: '', stderr: '' };
    outputs.push(this.rec);
    this.waiting = new Map();
    this.loose = [];
    this.looseWaiters = [];
    this.arrival = [];
    this.bad = [];
    this.nextId = 1;
    this.proc.stderr.on('data', (chunk) => { this.rec.stderr += chunk; });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      this.rec.stdout += `${line}\n`;
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* counted as bad below */ }
      if (!msg || msg.jsonrpc !== '2.0') { this.bad.push(line); return; }
      this.arrival.push(msg.id);
      const waiter = this.waiting.get(msg.id);
      if (waiter) { this.waiting.delete(msg.id); waiter(msg); } else if (this.looseWaiters.length) this.looseWaiters.shift()(msg); else this.loose.push(msg);
    });
    this.exited = new Promise((resolve) => this.proc.on('close', resolve));
    clients.push(this);
  }

  raw(text) { this.proc.stdin.write(`${text}\n`); }

  request(method, params, id = this.nextId++) {
    return withTimeout(new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    }), 15000, `reply to ${method}`);
  }

  nextLoose() {
    if (this.loose.length) return Promise.resolve(this.loose.shift());
    return withTimeout(new Promise((resolve) => this.looseWaiters.push(resolve)), 5000, 'a reply without a known id');
  }

  async call(name, args = {}, id) {
    const msg = await this.request('tools/call', { name, arguments: args }, id);
    assert.ok(msg.result, `tools/call ${name} gave a protocol error: ${JSON.stringify(msg.error)}`);
    const { content } = msg.result;
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    return { id: msg.id, isError: msg.result.isError === true, text: content[0].text, data: JSON.parse(content[0].text) };
  }

  async ok(name, args) {
    const out = await this.call(name, args);
    assert.equal(out.isError, false, `${name} failed: ${out.text}`);
    return out.data;
  }

  async fails(name, args, pattern) {
    const out = await this.call(name, args);
    assert.equal(out.isError, true, `${name} should have failed but returned: ${out.text}`);
    if (pattern) assert.match(out.data.error, pattern);
    return out;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.proc.stdin.end();
    await withTimeout(this.exited, 5000, 'server exit').catch(() => this.proc.kill());
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n     ')}`);
  }
}

const A = path.join(ROOT, 'a', 'store'); // the main sign in used by most tests
const dirA = envFor(A);
const TOOL_NAMES = ['sn_instance_info', 'sn_table_query', 'sn_table_get', 'sn_table_schema', 'sn_attachment_list', 'sn_attachment_download',
  'sn_table_create', 'sn_table_update', 'sn_table_delete', 'sn_attachment_upload', 'sn_attachment_delete',
  'sn_plan_change', 'sn_apply_plan', 'sn_undo_plan', 'sn_check_plan'];
const DIRECT_WRITE_TOOLS = TOOL_NAMES.slice(6, 11);
const WRITE_TOOLS = [...DIRECT_WRITE_TOOLS, 'sn_apply_plan', 'sn_undo_plan'];
const PLAN_ID_TOOLS = ['sn_apply_plan', 'sn_undo_plan', 'sn_check_plan'];
const ID = 'a'.repeat(32);
const NO_PLAN = '20261016-101500-0123abcd';
const uploadSource = path.join(ROOT, 'notes.docx');
fs.writeFileSync(uploadSource, crypto.randomBytes(2048));
// Arguments that pass validation for every tool.
const VALID = {
  sn_instance_info: {}, sn_table_query: { table: 'incident' }, sn_table_get: { table: 'incident', sys_id: ID },
  sn_table_schema: { table: 'incident' }, sn_attachment_list: { table: 'incident' },
  sn_attachment_download: { sys_id: ID, save_to: path.join(ROOT, 'never-written.bin') },
  sn_table_create: { table: 'incident', record: { short_description: 'x' } },
  sn_table_update: { table: 'incident', sys_id: ID, record: { state: '2' } },
  sn_table_delete: { table: 'incident', sys_id: ID },
  sn_attachment_upload: { table: 'incident', sys_id: ID, file_path: uploadSource },
  sn_attachment_delete: { sys_id: ID },
  sn_plan_change: { table: 'incident', sys_id: ID, record: { state: '2' } },
  sn_apply_plan: { plan_id: NO_PLAN }, sn_undo_plan: { plan_id: NO_PLAN }, sn_check_plan: { plan_id: NO_PLAN },
};
let main; // shared read-only MCP client for dir A
let pm; // MCP client for dir A with SN_ALLOW_WRITE=plan
const PLANS = path.join(A, 'plans'); // plans sit next to the config file
const savedPlan = (id) => JSON.parse(fs.readFileSync(path.join(PLANS, `${id}.json`), 'utf8'));
const writesSince = (mark) => S.requests.slice(mark).filter((r) => r.method !== 'GET');

await test('node --check server.mjs', async () => {
  const proc = spawn(process.execPath, ['--check', SERVER], { stdio: 'ignore' });
  assert.equal(await new Promise((resolve) => proc.on('close', resolve)), 0);
});

await test('mock: rejects missing token, wrong PKCE verifier and wrong client id', async () => {
  assert.equal((await fetch(`${mock.url}/api/now/table/incident`)).status, 401);
  const form = (body) => fetch(`${mock.url}/oauth_token.do`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const redirect = 'http://localhost:1/callback';
  const authorize = async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id: S.clientId, redirect_uri: redirect, state: 's', code_challenge: sha256url('right-verifier'), code_challenge_method: 'S256' });
    const res = await fetch(`${mock.url}/oauth_auth.do?${q}`, { redirect: 'manual' });
    return new URL(res.headers.get('location')).searchParams.get('code');
  };
  const wrongPkce = await form({ grant_type: 'authorization_code', code: await authorize(), redirect_uri: redirect, client_id: S.clientId, code_verifier: 'wrong-verifier' });
  assert.equal(wrongPkce.status, 400);
  const wrongClient = await form({ grant_type: 'authorization_code', code: await authorize(), redirect_uri: redirect, client_id: 'someone-else', code_verifier: 'right-verifier' });
  assert.equal(wrongClient.status, 401);
  const good = await form({ grant_type: 'authorization_code', code: await authorize(), redirect_uri: redirect, client_id: S.clientId, code_verifier: 'right-verifier' });
  assert.equal(good.status, 200);
});

await test('status before sign in: no instance, not signed in, read-only', async () => {
  const rec = await runCli(['status'], { PATH: STUB_BIN, HOME: FAKE_HOME });
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /Instance:\s+not set\n/);
  assert.match(rec.stdout, /Signed in:\s+no/);
  assert.match(rec.stdout, /Writes allowed:\s+no/);
  assert.ok(rec.stdout.includes(path.join(FAKE_HOME, '.config', 'servicenow-mcp', 'tokens.json')));
});

await test('login without an instance fails with a clear message', async () => {
  const rec = await runCli(['login', '--no-open'], envFor(path.join(ROOT, 'no-instance'), { SN_INSTANCE: undefined }));
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /No ServiceNow instance is set/);
});

await test('a bare instance name becomes a service-now.com address', async () => {
  const rec = await runCli(['status'], { PATH: STUB_BIN, HOME: FAKE_HOME, SN_INSTANCE: 'acme-dev' });
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /Instance:\s+https:\/\/acme-dev\.service-now\.com\n/);
  const host = await runCli(['status'], { PATH: STUB_BIN, HOME: FAKE_HOME, SN_INSTANCE: 'acme.example.com/' });
  assert.match(host.stdout, /Instance:\s+https:\/\/acme\.example\.com\n/);
});

await test('login without a client id fails with a clear message', async () => {
  const rec = await runCli(['login', '--no-open'], envFor(path.join(ROOT, 'none'), { SN_CLIENT_ID: undefined }));
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /client id/i);
});

await test('login: full PKCE flow against the mock with --no-open', async () => {
  const { port, url, cli } = await login(A);
  const bad = await fetch(`http://localhost:${port}/callback?code=whatever&state=not-the-state`);
  assert.equal(bad.status, 400, 'a callback with the wrong state must be refused');
  assert.equal(cli.rec.code, null, 'login keeps waiting after a bad callback');
  const page = await browse(url);
  const rec = await cli.done;
  assert.equal(rec.code, 0, rec.stderr);
  assert.ok(page.location.startsWith(`http://localhost:${port}/callback?`));
  assert.equal(page.status, 200);
  assert.match(page.html, /You can close this tab/);
  assert.ok(rec.stdout.includes(`Signed in to ${mock.url} as Ada Admin`), rec.stdout);
  assert.equal(fs.existsSync(OPEN_MARK), false, '--no-open must not run the open command');

  const q = S.lastAuthorize;
  assert.equal(q.response_type, 'code');
  assert.equal(q.client_id, S.clientId);
  assert.equal(q.redirect_uri, `http://localhost:${port}/callback`);
  assert.equal(q.code_challenge_method, 'S256');
  assert.ok(q.state.length >= 16);
  const verifier = S.issued.verifiers[S.issued.verifiers.length - 1];
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(sha256url(verifier), q.code_challenge);
  assert.match(S.lastTokenRequest.contentType, /^application\/x-www-form-urlencoded/);
  assert.equal(S.lastTokenRequest.hasSecret, false, 'a public client sends no secret');

  assert.equal(mode(dirA.SN_TOKEN_FILE), 0o600);
  assert.equal(mode(A), 0o700);
  const tokens = JSON.parse(fs.readFileSync(dirA.SN_TOKEN_FILE, 'utf8'));
  assert.deepEqual(Object.keys(tokens).sort(), ['access_token', 'client_id', 'expires_at', 'instance', 'refresh_token', 'scope', 'token_type']);
  assert.ok(tokens.expires_at > Date.now() + 60000);
  assert.equal(tokens.instance, mock.url);
  assert.equal(tokens.client_id, S.clientId);
  assert.deepEqual(JSON.parse(fs.readFileSync(dirA.SN_CONFIG_FILE, 'utf8')), { instance: mock.url, clientId: S.clientId, redirectPort: port });
});

await test('login: runs the open command with the URL unless --no-open (fake open, no browser)', async () => {
  const { url, cli } = await login(path.join(ROOT, 'b'), []);
  // The fake open creates the file before it writes the URL, so wait for the URL.
  const opened = () => fs.existsSync(OPEN_MARK) && fs.readFileSync(OPEN_MARK, 'utf8') !== '';
  for (let i = 0; i < 120 && !opened(); i += 1) await sleep(25);
  assert.equal(fs.readFileSync(OPEN_MARK, 'utf8'), url);
  await browse(url);
  assert.equal((await cli.done).code, 0);
});

await test('login: error= in the callback is reported and nothing is saved', async () => {
  const dir = path.join(ROOT, 'c');
  S.denyNextAuthorize = true;
  const { url, cli } = await login(dir);
  const page = await browse(url);
  const rec = await cli.done;
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /access_denied/);
  assert.match(page.html, /Sign in failed/);
  assert.equal(fs.existsSync(path.join(dir, 'tokens.json')), false);
});

await test('login: a wrong client id is rejected at the token exchange', async () => {
  const dir = path.join(ROOT, 'd');
  const { url, cli } = await login(dir, ['--no-open', '--client-id', 'not-the-client']);
  await browse(url);
  const rec = await cli.done;
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /invalid_client/);
  assert.equal(fs.existsSync(path.join(dir, 'tokens.json')), false);
});

await test('login: gives up with a clear message when nobody signs in', async () => {
  const { cli } = await login(path.join(ROOT, 't'), ['--no-open'], { SN_LOGIN_TIMEOUT_MS: '300' });
  const rec = await cli.done;
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /Timed out/);
  assert.equal(fs.existsSync(path.join(ROOT, 't', 'tokens.json')), false);
});

await test('status when signed in', async () => {
  const rec = await runCli(['status'], dirA);
  assert.equal(rec.code, 0);
  assert.ok(rec.stdout.includes(mock.url));
  assert.match(rec.stdout, /Signed in:\s+yes/);
  assert.match(rec.stdout, /Token expires:\s+\d{4}-\d\d-\d\dT[\d:.]+Z \(in about \d+ minutes\)/);
  assert.match(rec.stdout, /Writes allowed:\s+no/);
  const allowed = await runCli(['status'], envFor(A, { SN_ALLOW_WRITE: '1' }));
  assert.match(allowed.stdout, /Writes allowed:\s+yes/);
});

await test('MCP handshake: initialize, protocol versions, initialized notification, ping', async () => {
  main = new Mcp(dirA, 'serve main');
  for (const [asked, expected] of [['2025-06-18', '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2024-11-05', '2024-11-05'], ['1999-01-01', '2025-06-18']]) {
    const msg = await main.request('initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(msg.result.protocolVersion, expected);
    assert.deepEqual(msg.result.capabilities, { tools: {} });
    assert.deepEqual(msg.result.serverInfo, { name: 'servicenow-mcp', version: '0.1.0' });
    assert.match(msg.result.instructions, /read-only unless .*SN_ALLOW_WRITE=1/);
  }
  main.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const before = main.arrival.length;
  assert.deepEqual((await main.request('ping')).result, {});
  assert.equal(main.arrival.length, before + 1, 'the notification must not be answered');
});

await test('tools/list: every tool is there with a valid schema', async () => {
  const { tools } = (await main.request('tools/list', {})).result;
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of tools) {
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.type, 'object');
    const props = tool.inputSchema.properties;
    for (const [key, prop] of Object.entries(props)) {
      assert.ok(typeof prop.type === 'string' && prop.description.length > 5, `${tool.name}.${key} needs a type and a description`);
    }
    for (const key of tool.inputSchema.required || []) assert.ok(key in props, `${tool.name} requires unknown ${key}`);
    for (const key of Object.keys(VALID[tool.name])) assert.ok(key in props);
    assert.equal(tool.description.includes('SN_ALLOW_WRITE=1'), WRITE_TOOLS.includes(tool.name));
  }
});

await test('sn_instance_info, with the fallback user lookup', async () => {
  const expected = { instance: mock.url, user: { name: 'Ada Admin', user_name: 'ada.admin', sys_id: S.user.sys_id }, build: 'glide-mock-01-01-2026__patch0', writes_allowed: false, write_mode: 'off' };
  assert.deepEqual(await main.ok('sn_instance_info', {}), expected);
  S.disableCurrentUser = true;
  try {
    assert.deepEqual(await main.ok('sn_instance_info', {}), expected);
    const lookup = S.requests.filter((r) => r.path === '/api/now/table/sys_user').pop();
    assert.equal(lookup.query.sysparm_query, 'user_name=javascript:gs.getUserName()');
    assert.equal(lookup.query.sysparm_fields, 'sys_id,user_name,name');
  } finally { S.disableCurrentUser = false; }
});

await test('sn_table_query: defaults, query, fields, paging, order and display values', async () => {
  const all = await main.ok('sn_table_query', { table: 'incident' });
  assert.equal(all.count, 5);
  assert.equal(all.total, 5);
  assert.equal(typeof all.records[0].caller_id, 'string', 'reference links are excluded');
  assert.equal(lastRequest().query.sysparm_limit, '20');
  assert.equal(lastRequest().query.sysparm_exclude_reference_link, 'true');

  const some = await main.ok('sn_table_query', { table: 'incident', query: 'active=true', fields: 'number, short_description', limit: 2, offset: 1, order_by: 'DESCnumber' });
  assert.deepEqual(lastRequest().query, { sysparm_query: 'active=true^ORDERBYDESCnumber', sysparm_fields: 'number,short_description', sysparm_limit: '2', sysparm_offset: '1', sysparm_exclude_reference_link: 'true' });
  assert.equal(some.count, 2);
  assert.equal(some.total, 4);
  assert.deepEqual(some.records.map((r) => r.number), ['INC0000003', 'INC0000002']);
  assert.deepEqual(Object.keys(some.records[0]), ['number', 'short_description']);

  const shown = await main.ok('sn_table_query', { table: 'incident', query: 'number=INC0000001', display_value: 'true' });
  assert.equal(shown.records[0].caller_id, 'Bob Caller');
  await main.ok('sn_table_query', { table: 'incident', order_by: 'number' });
  assert.equal(lastRequest().query.sysparm_query, 'ORDERBYnumber');
});

await test('sn_table_get: found, and a 404 comes back as a tool error', async () => {
  const row = S.tables.incident[0];
  const got = await main.ok('sn_table_get', { table: 'incident', sys_id: row.sys_id, fields: 'number,caller_id', display_value: 'all' });
  assert.deepEqual(got.record, { number: { display_value: 'INC0000001', value: 'INC0000001' }, caller_id: { display_value: 'Bob Caller', value: row.caller_id } });
  const missing = await main.fails('sn_table_get', { table: 'incident', sys_id: ID }, /status 404.*No Record found/);
  assert.equal(missing.data.status, 404);
  assert.match(missing.data.detail, /ACL restricts/);
});

await test('sn_table_schema', async () => {
  const out = await main.ok('sn_table_schema', { table: 'incident' });
  assert.equal(out.count, 4);
  assert.deepEqual(out.columns.map((c) => c.element), ['number', 'short_description', 'caller_id', 'priority']);
  assert.deepEqual(out.columns[2], { element: 'caller_id', column_label: 'Caller', internal_type: 'reference', max_length: '32', mandatory: 'false', reference: 'sys_user' });
  assert.equal(lastRequest().query.sysparm_query, 'name=incident^elementISNOTEMPTY');
  assert.equal(lastRequest().query.sysparm_limit, '500');
});

await test('sn_attachment_list and sn_attachment_download', async () => {
  const row = S.tables.incident[0];
  const list = await main.ok('sn_attachment_list', { table: 'incident', sys_id: row.sys_id });
  assert.equal(lastRequest().query.sysparm_query, `table_name=incident^table_sys_id=${row.sys_id}`);
  assert.equal(list.count, 1);
  assert.deepEqual(Object.keys(list.attachments[0]), ['sys_id', 'file_name', 'content_type', 'size_bytes', 'table_name', 'table_sys_id', 'sys_created_on']);
  assert.equal(list.attachments[0].file_name, 'printer-log.txt');

  const target = path.join(ROOT, 'downloaded.txt');
  const args = { sys_id: list.attachments[0].sys_id, save_to: target };
  const first = await main.call('sn_attachment_download', args);
  assert.equal(first.isError, false, first.text);
  assert.deepEqual(first.data, { path: target, size_bytes: 36, content_type: 'text/plain' });
  assert.equal(first.text.includes('paper jam'), false, 'file contents are never returned inline');
  assert.equal(fs.readFileSync(target, 'utf8'), 'paper jam at 09:14\nrestart at 09:20\n');
  fs.writeFileSync(target, 'changed');
  await main.fails('sn_attachment_download', args, /already exists/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed');
  await main.ok('sn_attachment_download', { ...args, overwrite: true });
  assert.equal(fs.readFileSync(target, 'utf8').length, 36);
  assert.deepEqual(fs.readdirSync(ROOT).filter((name) => name.includes('.part-')), []);
});

await test('every API request carried a Bearer token and Accept: application/json', async () => {
  const sent = S.requests.slice(1); // the first one is the deliberate no token probe
  assert.ok(sent.length > 10);
  for (const r of sent) {
    assert.equal(r.bearer, true);
    if (r.path.endsWith('/file') && r.method === 'GET') assert.ok(r.accept.startsWith('application/json'));
    else assert.equal(r.accept, 'application/json');
  }
});

await test('input validation returns tool errors and sends nothing', async () => {
  const before = S.counts.total;
  const cases = [
    ['sn_table_query', {}, /Missing required argument: table/],
    ['sn_table_query', { table: 'Bad-Table!' }, /table must be a table name/],
    ['sn_table_query', { table: 'incident/../sys_user' }, /table must be a table name/],
    ['sn_table_query', { table: 'incident', limit: 'lots' }, /limit must be a whole number from 1 to 200/],
    ['sn_table_query', { table: 'incident', limit: 201 }, /limit must be a whole number/],
    ['sn_table_query', { table: 'incident', offset: -1 }, /offset must be a whole number/],
    ['sn_table_query', { table: 'incident', display_value: 'maybe' }, /display_value must be one of/],
    ['sn_table_query', { table: 'incident', order_by: 'number^active=true' }, /order_by must be a single column/],
    ['sn_table_query', { table: 'incident', sysparm_query: 'x' }, /Unknown argument: sysparm_query/],
    ['sn_table_get', { table: 'incident', sys_id: 'xyz' }, /32 hex characters/],
    ['sn_table_get', { table: 'incident', sys_id: ID, fields: 'a;b' }, /fields must be a comma separated list/],
    ['sn_attachment_list', { sys_id: '123' }, /32 hex characters/],
    ['sn_attachment_download', { sys_id: ID, save_to: 'relative/file.txt' }, /absolute local path/],
    ['sn_attachment_download', { sys_id: ID, save_to: path.join(ROOT, 'no-such-folder', 'f.txt') }, /does not exist/],
    ['sn_plan_change', { table: 'incident', record: {} }, /at least one field/],
    ['sn_plan_change', { table: 'incident', record: { 'caller_id.name': 'x' } }, /not a column name/],
    ['sn_plan_change', { table: 'incident', sys_id: ID, record: { sys_mod_count: '9' } }, /kept by ServiceNow itself/],
    ['sn_plan_change', { table: 'incident', record: { state: { value: '2' } } }, /must be text, a number, true or false, or null/],
    ['sn_plan_change', { table: 'incident', record: { state: '2' }, reason: 7 }, /reason must be a string/],
    ['sn_check_plan', { plan_id: '../tokens' }, /plan_id must be a plan id/],
    ['sn_check_plan', { plan_id: NO_PLAN }, /There is no plan/],
  ];
  for (const [name, args, pattern] of cases) await main.fails(name, args, pattern);
  const notObject = await main.request('tools/call', { name: 'sn_table_query', arguments: 'incident' });
  assert.equal(notObject.result.isError, true);
  assert.equal(S.counts.total, before);
});

await test('write tools are refused unless SN_ALLOW_WRITE is exactly 1 (or plan)', async () => {
  const before = S.counts.total;
  const almost = new Mcp(envFor(A, { SN_ALLOW_WRITE: 'true' }), 'serve allow=true');
  for (const name of WRITE_TOOLS) {
    await main.fails(name, VALID[name], /SN_ALLOW_WRITE=1/);
    await almost.fails(name, VALID[name], /SN_ALLOW_WRITE=1/);
  }
  await almost.close();
  assert.equal(S.counts.total, before, 'nothing may reach ServiceNow');
});

await test('write tools work with SN_ALLOW_WRITE=1, and a 403 is passed on', async () => {
  const rw = new Mcp(envFor(A, { SN_ALLOW_WRITE: '1' }), 'serve write');
  assert.equal((await rw.ok('sn_instance_info', {})).writes_allowed, true);
  const made = await rw.ok('sn_table_create', { table: 'incident', record: { short_description: 'Made by the test', state: '1' } });
  const id = made.record.sys_id;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(lastRequest().method, 'POST');
  const changed = await rw.ok('sn_table_update', { table: 'incident', sys_id: id, record: { state: '2' } });
  assert.equal(lastRequest().method, 'PATCH');
  assert.equal(changed.record.state, '2');
  assert.equal((await rw.ok('sn_table_get', { table: 'incident', sys_id: id })).record.short_description, 'Made by the test');

  const up = await rw.ok('sn_attachment_upload', { table: 'incident', sys_id: id, file_path: uploadSource });
  assert.deepEqual(lastRequest().query, { table_name: 'incident', table_sys_id: id, file_name: 'notes.docx' });
  assert.equal(lastRequest().contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(up.attachment.size_bytes, '2048');
  assert.ok(S.attachments.get(up.attachment.sys_id).bytes.equals(fs.readFileSync(uploadSource)));
  const back = path.join(ROOT, 'round-trip.docx');
  await rw.ok('sn_attachment_download', { sys_id: up.attachment.sys_id, save_to: back });
  assert.ok(fs.readFileSync(back).equals(fs.readFileSync(uploadSource)));
  await rw.ok('sn_attachment_delete', { sys_id: up.attachment.sys_id });
  assert.equal((await rw.ok('sn_attachment_list', { table: 'incident', sys_id: id })).count, 0);

  await rw.ok('sn_table_delete', { table: 'incident', sys_id: id });
  assert.equal(lastRequest().method, 'DELETE');
  await rw.fails('sn_table_get', { table: 'incident', sys_id: id }, /status 404/);
  const denied = await rw.fails('sn_table_update', { table: 'sys_properties', sys_id: S.tables.sys_properties[0].sys_id, record: { value: 'x' } }, /status 403.*Operation Failed/);
  assert.equal(denied.data.status, 403);
  assert.match(denied.data.detail, /ACL Exception/);
  await rw.close();
});

let firstPlan; // planned, applied, checked for drift and undone by the tests below
await test('sn_plan_change: saves a before and after diff and writes nothing, even with writes off', async () => {
  const row = S.tables.incident[1];
  const bob = S.tables.sys_user[1].sys_id;
  const mark = S.requests.length;
  const writes = S.counts.writes;
  const plan = await main.ok('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { state: 3, priority: '2', assigned_to: bob }, reason: 'Waiting on the vendor' });
  assert.match(plan.plan_id, /^\d{8}-\d{6}-[0-9a-f]{8}$/);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.action, 'update');
  assert.deepEqual(plan.changes, [
    { field: 'state', before: '2', after: '3' },
    { field: 'assigned_to', before: S.user.sys_id, after: bob, before_display: 'Ada Admin' },
  ]);
  assert.deepEqual(plan.no_change, ['priority']);
  assert.deepEqual(plan.base, { sys_mod_count: '0', sys_updated_on: row.sys_updated_on, sys_updated_by: 'system' });
  assert.equal(plan.reason, 'Waiting on the vendor');
  assert.match(plan.note, /Nothing was sent to ServiceNow/);
  assert.deepEqual(plan.warnings, [], 'a valid choice and an existing reference pass the field checks');
  assert.deepEqual(writesSince(mark), [], 'planning only reads');
  assert.equal(S.counts.writes, writes);
  const read = S.requests.slice(mark).find((r) => r.path === `/api/now/table/incident/${row.sys_id}`);
  assert.equal(read.query.sysparm_display_value, 'all');
  assert.equal(read.query.sysparm_fields, 'state,priority,assigned_to,sys_mod_count,sys_updated_on,sys_updated_by');

  assert.equal(plan.plan_file, path.join(PLANS, `${plan.plan_id}.json`));
  assert.equal(mode(plan.plan_file), 0o600);
  assert.equal(mode(PLANS), 0o700);
  const saved = savedPlan(plan.plan_id);
  assert.deepEqual(saved.changes, plan.changes);
  assert.equal(saved.instance, mock.url);
  assert.equal(saved.plan_file, undefined, 'the file holds the plan, not the extras of the reply');

  await main.fails('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { state: '2' } }, /already has the planned value.*No plan was saved/);
  await main.fails('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { u_nope: 'x' } }, /did not return u_nope.*No plan was saved/);
  await main.fails('sn_plan_change', { table: 'no_such_table', record: { name: 'x' } }, /status 400/);
  assert.deepEqual(fs.readdirSync(PLANS), [`${plan.plan_id}.json`], 'a refused plan leaves no file');
  firstPlan = plan.plan_id;
});

await test('SN_ALLOW_WRITE=plan: only the plan tools write, the direct ones refuse', async () => {
  pm = new Mcp(envFor(A, { SN_ALLOW_WRITE: 'plan' }), 'serve plan mode');
  const before = S.counts.total;
  for (const name of DIRECT_WRITE_TOOLS) await pm.fails(name, VALID[name], /only writes through reviewed plans \(SN_ALLOW_WRITE=plan\)/);
  assert.equal(S.counts.total, before, 'nothing may reach ServiceNow');
  const info = await pm.ok('sn_instance_info', {});
  assert.equal(info.write_mode, 'plan');
  assert.equal(info.writes_allowed, true);
  const status = await runCli(['status'], envFor(A, { SN_ALLOW_WRITE: 'plan' }));
  assert.match(status.stdout, /Writes allowed:\s+only through sn_apply_plan \(SN_ALLOW_WRITE=plan\)/);
  assert.ok(status.stdout.includes(`Plans folder:    ${PLANS}\n`), status.stdout);
});

await test('sn_apply_plan: writes exactly the planned fields, reads them back, and only once', async () => {
  const row = S.tables.incident[1];
  const bob = S.tables.sys_user[1].sys_id;
  const mark = S.requests.length;
  const out = await pm.ok('sn_apply_plan', { plan_id: firstPlan });
  const writes = writesSince(mark);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].path, `/api/now/table/incident/${row.sys_id}`);
  assert.deepEqual(writes[0].body, { state: '3', assigned_to: bob }, 'only the changed fields, as planned');
  assert.equal(out.status, 'applied');
  assert.equal(out.matches_plan, true);
  assert.deepEqual(out.stored, { state: '3', assigned_to: bob });
  assert.deepEqual(out.mismatches, []);
  assert.match(out.note, /sn_undo_plan/);
  assert.equal(row.state, '3');
  const saved = savedPlan(firstPlan);
  assert.equal(saved.status, 'applied');
  assert.equal(saved.applied.sys_mod_count, '1');
  assert.equal(saved.applied.sys_updated_by, 'ada.admin');
  assert.deepEqual(fs.readdirSync(PLANS).filter((name) => !name.endsWith('.json')), [], 'no lock or temp file is left');

  await pm.fails('sn_apply_plan', { plan_id: firstPlan }, /already applied/);
  assert.equal(writesSince(mark).length, 1, 'a plan is written once');
  const check = await main.ok('sn_check_plan', { plan_id: firstPlan });
  assert.deepEqual(check, {
    plan_id: firstPlan, status: 'applied', action: 'update', table: 'incident', sys_id: row.sys_id,
    record_exists: true, in_sync: true, drift: [], changed_since_apply: false,
    last_updated_by: 'ada.admin', last_updated_on: row.sys_updated_on,
    note: 'Every planned field still holds the value the plan left there.',
  });
});

await test('sn_check_plan reports drift, and sn_undo_plan will not overwrite it', async () => {
  const row = S.tables.incident[1];
  S.touch('incident', row.sys_id, { short_description: 'Only the title changed' });
  let check = await main.ok('sn_check_plan', { plan_id: firstPlan });
  assert.equal(check.in_sync, true);
  assert.equal(check.changed_since_apply, true);
  assert.deepEqual(check.drift, []);
  assert.match(check.note, /not in the planned fields/);

  S.touch('incident', row.sys_id, { state: '1' });
  check = await main.ok('sn_check_plan', { plan_id: firstPlan });
  assert.equal(check.in_sync, false);
  assert.deepEqual(check.drift, [{ field: 'state', expected: '3', now: '1' }]);
  assert.equal(check.last_updated_by, 'bob.caller');

  const writes = S.counts.writes;
  await pm.fails('sn_undo_plan', { plan_id: firstPlan }, /Not undone.*bob\.caller.*state \(expected "3", now "1"\)/);
  assert.equal(S.counts.writes, writes, 'nothing was written');
  assert.equal(savedPlan(firstPlan).status, 'applied');
});

await test('sn_undo_plan puts the old values back and leaves other fields alone', async () => {
  const row = S.tables.incident[1];
  S.touch('incident', row.sys_id, { state: '3' }); // Bob puts the planned value back
  const mark = S.requests.length;
  const out = await pm.ok('sn_undo_plan', { plan_id: firstPlan });
  const writes = writesSince(mark);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { state: '2', assigned_to: S.user.sys_id });
  assert.equal(out.status, 'undone');
  assert.equal(out.matches_before, true);
  assert.equal(row.state, '2');
  assert.equal(row.assigned_to, S.user.sys_id);
  assert.equal(row.short_description, 'Only the title changed', 'a field outside the plan is not touched');
  assert.equal(savedPlan(firstPlan).status, 'undone');
  const check = await main.ok('sn_check_plan', { plan_id: firstPlan });
  assert.equal(check.in_sync, true);
  assert.equal(check.changed_since_undo, false);
  await pm.fails('sn_undo_plan', { plan_id: firstPlan }, /already undone/);
  await pm.fails('sn_apply_plan', { plan_id: firstPlan }, /applied and then undone/);
});

await test('sn_apply_plan refuses a plan when the record changed after it was made', async () => {
  const row = S.tables.incident[2];
  const plan = await pm.ok('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { state: '2' } });
  S.touch('incident', row.sys_id, { state: '6' });
  const check = await main.ok('sn_check_plan', { plan_id: plan.plan_id });
  assert.equal(check.can_apply, false);
  assert.equal(check.changed_since_plan, true);
  assert.deepEqual(check.differences, [{ field: 'state', planned_from: '1', now: '6' }]);
  const writes = S.counts.writes;
  await pm.fails('sn_apply_plan', { plan_id: plan.plan_id }, /changed by bob\.caller at .* after this plan was made, so nothing was written\. Planned fields that changed: state \(was "1", now "6"\)/);
  assert.equal(S.counts.writes, writes);
  assert.equal(row.state, '6');
  const saved = savedPlan(plan.plan_id);
  assert.equal(saved.status, 'planned');
  assert.equal(saved.last_error.during, 'apply');
  assert.match(saved.last_error.error, /after this plan was made/);
});

await test('when ServiceNow refuses the write, the plan stays unapplied with the reason kept', async () => {
  const prop = S.tables.sys_properties[1];
  const plan = await pm.ok('sn_plan_change', { table: 'sys_properties', sys_id: prop.sys_id, record: { value: 'Changed' } });
  const out = await pm.fails('sn_apply_plan', { plan_id: plan.plan_id }, /status 403.*Operation Failed/);
  assert.equal(out.data.status, 403);
  assert.match(out.data.detail, /ACL Exception/);
  assert.equal(prop.value, 'Mock');
  const saved = savedPlan(plan.plan_id);
  assert.equal(saved.status, 'planned');
  assert.match(saved.last_error.error, /403/);
  assert.equal((await main.ok('sn_check_plan', { plan_id: plan.plan_id })).can_apply, true, 'nothing changed, so it can be tried again');
});

await test('sn_apply_plan reports a field that a business rule changed', async () => {
  const row = S.tables.incident[4];
  S.rules.push((table, rec) => { if (table === 'incident' && rec.priority === '1') rec.priority = '2'; });
  try {
    const plan = await pm.ok('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { priority: 1, short_description: 'Printer out of toner on every floor' } });
    const out = await pm.ok('sn_apply_plan', { plan_id: plan.plan_id });
    assert.equal(out.matches_plan, false);
    assert.deepEqual(out.mismatches, [{ field: 'priority', sent: '1', stored: '2' }]);
    assert.deepEqual(out.stored, { priority: '2', short_description: 'Printer out of toner on every floor' });
    assert.match(out.note, /something other than what was sent for: priority\. A business rule/);
    const check = await main.ok('sn_check_plan', { plan_id: plan.plan_id });
    assert.equal(check.in_sync, true, 'apply already reported what the rule stored, so it is not drift');
  } finally { S.rules.length = 0; }
});

await test('a plan can create a record, and undo deletes it again', async () => {
  const count = S.tables.incident.length;
  const mark = S.requests.length;
  const plan = await pm.ok('sn_plan_change', { table: 'incident', record: { short_description: 'Planned printer', priority: 4 } });
  assert.equal(plan.action, 'create');
  assert.equal(plan.sys_id, null);
  assert.equal(plan.base, null);
  assert.deepEqual(plan.changes, [
    { field: 'short_description', before: null, after: 'Planned printer' },
    { field: 'priority', before: null, after: '4' },
  ]);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(writesSince(mark), []);
  assert.equal((await main.ok('sn_check_plan', { plan_id: plan.plan_id })).can_apply, true);

  const out = await pm.ok('sn_apply_plan', { plan_id: plan.plan_id });
  const [post] = writesSince(mark);
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { short_description: 'Planned printer', priority: '4' });
  assert.match(out.sys_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(out.mismatches, []);
  assert.equal(S.tables.incident.length, count + 1);
  assert.equal(savedPlan(plan.plan_id).applied.sys_id, out.sys_id);
  assert.equal((await main.ok('sn_check_plan', { plan_id: plan.plan_id })).in_sync, true);

  const undo = await pm.ok('sn_undo_plan', { plan_id: plan.plan_id });
  assert.equal(undo.deleted, true);
  assert.equal(lastRequest().method, 'DELETE');
  assert.equal(S.tables.incident.length, count);
  const gone = await main.ok('sn_check_plan', { plan_id: plan.plan_id });
  assert.equal(gone.record_exists, false);
  assert.equal(gone.in_sync, true);
});

await test('a plan is refused while locked, for another instance, or when edited into something unsafe', async () => {
  const row = S.tables.incident[3];
  const plan = await pm.ok('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { state: '1' } });
  const writes = S.counts.writes;
  const lock = path.join(PLANS, `${plan.plan_id}.lock`);
  fs.writeFileSync(lock, '1\n');
  await pm.fails('sn_apply_plan', { plan_id: plan.plan_id }, /already being applied or undone/);
  fs.unlinkSync(lock);
  const original = fs.readFileSync(plan.plan_file, 'utf8');
  const edit = (changes) => fs.writeFileSync(plan.plan_file, JSON.stringify({ ...JSON.parse(original), ...changes }));
  edit({ instance: 'https://elsewhere.service-now.com' });
  await pm.fails('sn_apply_plan', { plan_id: plan.plan_id }, /made for https:\/\/elsewhere\.service-now\.com, but this server is set up for/);
  edit({ table: '../sys_user' });
  await pm.fails('sn_apply_plan', { plan_id: plan.plan_id }, /is not a plan this server can read/);
  edit({ changes: [{ field: 'sys_mod_count', before: '0', after: '9' }] });
  await pm.fails('sn_apply_plan', { plan_id: plan.plan_id }, /is not a plan this server can read/);
  fs.writeFileSync(plan.plan_file, original);
  assert.equal(S.counts.writes, writes, 'nothing was written');
  assert.equal(row.state, '7');
});

await test('field checks: a plan with doubtful values is saved with a warning for each', async () => {
  const row = S.tables.incident[0];
  const mark = S.requests.length;
  const plan = await main.ok('sn_plan_change', {
    table: 'incident',
    sys_id: row.sys_id,
    record: { state: '4', assigned_to: ID, caller_id: 'Bob Caller', priority: 'high', short_description: 'x'.repeat(200), number: 'INC9', active: 'maybe' },
  });
  assert.deepEqual(plan.warnings, [
    { field: 'state', check: 'choice', message: '"4" is not a choice for incident.state. The choices are: 1 (New), 2 (In Progress), 3 (On Hold), 6 (Resolved), 7 (Closed), 8 (Canceled).' },
    { field: 'assigned_to', check: 'reference', message: `There is no sys_user record with sys_id ${ID}, or you are not allowed to read it.` },
    { field: 'caller_id', check: 'reference', message: '"Bob Caller" is not a sys_id. ServiceNow would try to match it to a sys_user record by its display value, which may find the wrong record or none.' },
    { field: 'priority', check: 'type', message: '"high" is not a whole number, but priority is an integer column.' },
    { field: 'short_description', check: 'max_length', message: 'The value is 200 characters long, but short_description holds at most 160. ServiceNow would cut it off.' },
    { field: 'number', check: 'read_only', message: 'number is read only in the dictionary. Check that it is meant to be changed.' },
    { field: 'active', check: 'read_only', message: 'active is read only in the dictionary. Check that it is meant to be changed.' },
    { field: 'active', check: 'type', message: '"maybe" is not true or false, but active is a true or false column.' },
  ], 'task allows state 4 but incident has its own choices, and incident overrides active to read only');
  assert.match(plan.note, /found 8 problems, see warnings/);
  assert.deepEqual(savedPlan(plan.plan_id).warnings, plan.warnings);
  assert.deepEqual(writesSince(mark), [], 'the checks only read');

  const emptied = await main.ok('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { short_description: '' } });
  assert.deepEqual(emptied.warnings, [{ field: 'short_description', check: 'mandatory', message: 'short_description is mandatory and the plan empties it.' }]);
});

await test('field checks for a new record: an unknown column blocks the plan, a missing mandatory one warns', async () => {
  const mark = S.requests.length;
  await main.fails('sn_plan_change', { table: 'incident', record: { priority: '3', u_nope: 'x' } }, /not defined on incident or the tables it extends: u_nope\. .*No plan was saved/);
  const plan = await main.ok('sn_plan_change', { table: 'incident', record: { priority: '3', state: '2' } });
  assert.deepEqual(plan.warnings, [{ field: 'short_description', check: 'mandatory', message: 'short_description is mandatory and the plan leaves it empty.' }],
    'state is found on task, the table incident extends');
  assert.deepEqual(writesSince(mark), []);
});

await test('field checks are skipped with a warning when the dictionary cannot be read', async () => {
  const row = S.tables.incident[0];
  S.hidden.add('sys_dictionary');
  try {
    const plan = await main.ok('sn_plan_change', { table: 'incident', sys_id: row.sys_id, record: { priority: 'high' } });
    assert.equal(plan.warnings.length, 1);
    assert.equal(plan.warnings[0].check, 'skipped');
    assert.match(plan.warnings[0].message, /skipped because a dictionary read failed: .*403.*The plan was saved without them\./);
    assert.match(plan.note, /^Nothing was sent to ServiceNow\. Show these changes/, 'a skipped check is not counted as a problem');
    const created = await main.ok('sn_plan_change', { table: 'incident', record: { u_nope: 'x' } });
    assert.equal(created.warnings[0].check, 'skipped', 'without the dictionary an unknown column cannot be told apart, so it is not blocked');
  } finally { S.hidden.clear(); }
});

await test('config file: found without env vars, allowWrite honoured, env wins', async () => {
  const bare = new Mcp(envFor(A, { SN_INSTANCE: undefined, SN_CLIENT_ID: undefined }), 'serve config only');
  assert.equal((await bare.ok('sn_instance_info', {})).instance, mock.url);
  await bare.close();

  const F = path.join(ROOT, 'f');
  fs.mkdirSync(F, { mode: 0o700 });
  fs.copyFileSync(dirA.SN_TOKEN_FILE, path.join(F, 'tokens.json'));
  fs.chmodSync(path.join(F, 'tokens.json'), 0o600);
  fs.writeFileSync(path.join(F, 'config.json'), JSON.stringify({ instance: mock.url, clientId: S.clientId, allowWrite: true }));
  const viaFile = new Mcp(envFor(F, { SN_INSTANCE: undefined, SN_CLIENT_ID: undefined }), 'serve config allowWrite');
  assert.equal((await viaFile.ok('sn_instance_info', {})).writes_allowed, true);
  await viaFile.close();
  fs.writeFileSync(path.join(F, 'config.json'), JSON.stringify({ instance: mock.url, clientId: S.clientId, allowWrite: 'plan' }));
  const planOnly = new Mcp(envFor(F, { SN_INSTANCE: undefined, SN_CLIENT_ID: undefined }), 'serve config plan');
  assert.equal((await planOnly.ok('sn_instance_info', {})).write_mode, 'plan');
  await planOnly.fails('sn_table_delete', VALID.sn_table_delete, /SN_ALLOW_WRITE=plan/);
  await planOnly.close();
  const envWins = new Mcp(envFor(F, { SN_ALLOW_WRITE: '0' }), 'serve env wins');
  assert.equal((await envWins.ok('sn_instance_info', {})).writes_allowed, false);
  await envWins.fails('sn_table_delete', VALID.sn_table_delete, /SN_ALLOW_WRITE=1/);
  await envWins.close();
});

await test('a 401 triggers one refresh and one retry, even with calls in flight together', async () => {
  const before = { ...S.counts };
  const old = JSON.parse(fs.readFileSync(dirA.SN_TOKEN_FILE, 'utf8'));
  S.revokeAccessTokens();
  const results = await Promise.all([1, 2, 3].map(() => main.ok('sn_table_query', { table: 'incident', limit: 1 })));
  for (const r of results) assert.equal(r.count, 1);
  assert.equal(S.counts.refreshGrants - before.refreshGrants, 1, 'exactly one refresh');
  assert.ok(S.counts.unauthorized - before.unauthorized >= 1);
  const now = JSON.parse(fs.readFileSync(dirA.SN_TOKEN_FILE, 'utf8'));
  assert.notEqual(now.access_token, old.access_token);
  assert.equal(now.refresh_token, old.refresh_token);
  assert.equal(mode(dirA.SN_TOKEN_FILE), 0o600);
  await main.ok('sn_table_query', { table: 'incident', limit: 1 });
  assert.equal(S.counts.refreshGrants - before.refreshGrants, 1, 'no further refresh once the token is good');
});

const E = path.join(ROOT, 'e');
await test('an expired access token (1 second lifetime) is refreshed before the call', async () => {
  S.accessTokenTtlSeconds = 1;
  try {
    await signIn(E);
    const old = JSON.parse(fs.readFileSync(path.join(E, 'tokens.json'), 'utf8'));
    await sleep(1300);
    const before = { ...S.counts };
    const short = new Mcp(envFor(E), 'serve short tokens');
    assert.equal((await short.ok('sn_table_query', { table: 'incident', limit: 2 })).count, 2);
    assert.equal(S.counts.refreshGrants - before.refreshGrants, 1);
    assert.equal(S.counts.unauthorized, before.unauthorized, 'the stale token was never sent');
    const now = JSON.parse(fs.readFileSync(path.join(E, 'tokens.json'), 'utf8'));
    assert.notEqual(now.access_token, old.access_token);
    assert.equal(mode(path.join(E, 'tokens.json')), 0o600);
    assert.deepEqual(fs.readdirSync(E).sort(), ['config.json', 'tokens.json'], 'no temp files left behind');
    await short.close();
  } finally { S.accessTokenTtlSeconds = 1800; }
});

await test('when the refresh is rejected the tool says to run login again', async () => {
  await sleep(1100); // the 1 second token from the test above is stale again
  const stale = new Mcp(envFor(E), 'serve refresh rejected');
  S.rejectRefresh = true;
  try {
    const out = await stale.fails('sn_table_query', { table: 'incident' }, /could not be renewed/);
    assert.ok(out.data.error.includes(`node ${SERVER} login`), out.data.error);
  } finally { S.rejectRefresh = false; }
  assert.equal((await stale.ok('sn_table_query', { table: 'incident' })).count, 5);
  await stale.close();
});

await test('not signed in: every tool points at the login command', async () => {
  const before = S.counts.total;
  const anon = new Mcp(envFor(path.join(ROOT, 'empty'), { SN_ALLOW_WRITE: '1' }), 'serve signed out');
  for (const name of TOOL_NAMES.filter((tool) => !PLAN_ID_TOOLS.includes(tool))) {
    const out = await anon.fails(name, VALID[name], /Not signed in/);
    assert.ok(out.data.error.includes(`Run \`node ${SERVER} login\` first.`), out.data.error);
  }
  // These look for the plan file first, and there is none here.
  for (const name of PLAN_ID_TOOLS) await anon.fails(name, VALID[name], /There is no plan/);
  await anon.close();
  assert.equal(S.counts.total, before);
});

await test('a sign in for another instance is not used', async () => {
  const before = S.counts.total;
  const other = new Mcp(envFor(A, { SN_INSTANCE: 'http://127.0.0.1:9' }), 'serve other instance');
  await other.fails('sn_table_query', { table: 'incident' }, /saved sign in is for .* login/);
  await other.close();
  assert.equal(S.counts.total, before);
});

await test('malformed JSON, unknown method and unknown tool', async () => {
  main.raw('{"jsonrpc": "2.0", "id": 5, "method": ');
  const parse = await main.nextLoose();
  assert.deepEqual({ id: parse.id, code: parse.error.code }, { id: null, code: -32700 });
  const unknown = await main.request('resources/list', {});
  assert.equal(unknown.error.code, -32601);
  assert.equal(unknown.result, undefined);
  assert.equal((await main.request('tools/call', { name: 'sn_drop_everything', arguments: {} })).error.code, -32602);
  assert.deepEqual((await main.request('ping')).result, {}, 'the server keeps working afterwards');
});

await test('two requests in flight at once are answered with the right ids', async () => {
  S.delays['/api/now/table/incident'] = 400;
  try {
    const slow = main.call('sn_table_query', { table: 'incident', limit: 1 }, 'slow-1');
    const fast = main.call('sn_table_query', { table: 'sys_user', limit: 1 }, 902);
    const [a, b] = await Promise.all([slow, fast]);
    assert.equal(a.id, 'slow-1');
    assert.ok(a.data.records[0].number.startsWith('INC'));
    assert.equal(b.id, 902);
    assert.equal(b.data.records[0].user_name, 'ada.admin');
    assert.ok(main.arrival.indexOf(902) < main.arrival.indexOf('slow-1'), 'the quick request is not held up by the slow one');
  } finally { delete S.delays['/api/now/table/incident']; }
});

await test('a request that takes too long ends as a tool error', async () => {
  const hasty = new Mcp(envFor(A, { SN_HTTP_TIMEOUT_MS: '300' }), 'serve short timeout');
  S.delays['/api/now/table/incident'] = 1500;
  try {
    await hasty.fails('sn_table_query', { table: 'incident' }, /timed out/);
  } finally { delete S.delays['/api/now/table/incident']; }
  await hasty.close();
});

await test('logout removes the token file and status agrees', async () => {
  await main.close();
  const out = await runCli(['logout'], dirA);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /Signed out/);
  assert.equal(fs.existsSync(dirA.SN_TOKEN_FILE), false);
  assert.match((await runCli(['status'], dirA)).stdout, /Signed in:\s+no/);
  const again = await runCli(['logout'], dirA);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /Already signed out/);
});

await test('stdout of every server process held only JSON-RPC messages', async () => {
  for (const client of clients) await client.close();
  assert.ok(clients.length >= 8);
  for (const client of clients) assert.deepEqual(client.bad, [], `${client.rec.label} wrote something else to stdout`);
});

await test('no token, authorization code or verifier in any output', async () => {
  const secrets = S.allSecrets();
  assert.ok(S.issued.accessTokens.length >= 6 && S.issued.refreshTokens.length >= 3 && S.issued.codes.length >= 4 && S.issued.verifiers.length >= 3);
  assert.ok(outputs.length >= 20);
  for (const rec of outputs) {
    for (const secret of secrets) {
      assert.equal(`${rec.stdout}\n${rec.stderr}`.includes(secret), false, `a secret leaked in the output of: ${rec.label}`);
    }
  }
});

// Built from character codes so this file does not contain the characters itself.
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2012, 0x2013, 0x2014, 0x2015)}]`);
await test('no long dashes in any file of this folder', async () => {
  const files = ['server.mjs', 'README.md', 'test/mock-servicenow.mjs', 'test/run-tests.mjs'];
  for (const name of files) {
    const text = fs.readFileSync(path.join(HERE, '..', name), 'utf8');
    assert.equal(LONG_DASH.test(text), false, `${name} contains a long dash`);
  }
});

for (const client of clients) await client.close();
await mock.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
