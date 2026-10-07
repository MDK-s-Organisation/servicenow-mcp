#!/usr/bin/env node
// servicenow-mcp
// A small MCP server that lets an MCP client such as Claude work with a ServiceNow instance
// through the standard REST API, plus a tiny CLI for signing in.
// Node 18 or newer. Standard library only, no npm packages.
//
// Usage:
//   node server.mjs            run as an MCP server over stdio
//   node server.mjs login      sign in with OAuth (authorization code with PKCE)
//   node server.mjs status     show the current setup, never the tokens
//   node server.mjs logout     delete the saved tokens

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';

const SERVER_NAME = 'servicenow-mcp';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const DEFAULT_PORT = 8787;
const REFRESH_MARGIN_MS = 60 * 1000;

// These two exist so the tests can run quickly. Leave them unset in normal use.
const HTTP_TIMEOUT_MS = positiveInt(process.env.SN_HTTP_TIMEOUT_MS) || 60 * 1000;
const LOGIN_TIMEOUT_MS = positiveInt(process.env.SN_LOGIN_TIMEOUT_MS) || 5 * 60 * 1000;

const SELF_PATH = selfPath();

const TABLE_RE = /^[a-z0-9_]+$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const FIELD_RE = /^[A-Za-z0-9_.]+$/;

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function selfPath() {
  try {
    return decodeURIComponent(new URL(import.meta.url).pathname);
  } catch {
    return path.resolve(process.argv[1] || 'server.mjs');
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// A problem that should be shown to the caller as a tool error.
class ToolError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ToolError';
    Object.assign(this, extra);
  }
}

// A JSON-RPC level error (bad method, bad params).
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Keeping secrets out of every kind of output
// ---------------------------------------------------------------------------

// Every token, authorization code and PKCE verifier this process has seen.
const secrets = new Set();

function remember(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

// Remove known secret values from a piece of text.
function scrub(text) {
  let out = String(text);
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

// Stricter version for error text, which may quote things we have not seen.
function scrubError(text) {
  return scrub(text)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/("?(?:access_token|refresh_token|code_verifier|client_secret)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1[redacted]')
    .replace(/([?&]code=)[^&\s"']+/gi, '$1[redacted]');
}

function logError(text) {
  process.stderr.write(`[${SERVER_NAME}] ${scrubError(text)}\n`);
}

// ---------------------------------------------------------------------------
// Configuration: environment variables win over the config file
// ---------------------------------------------------------------------------

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultDir() {
  return path.join(os.homedir(), '.config', 'servicenow-mcp');
}

function configFilePath() {
  return path.resolve(expandHome(process.env.SN_CONFIG_FILE || path.join(defaultDir(), 'config.json')));
}

function tokenFilePath() {
  return path.resolve(expandHome(process.env.SN_TOKEN_FILE || path.join(defaultDir(), 'tokens.json')));
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// Returns the base URL without a trailing slash. Plain http is only accepted
// for this machine, so tokens never travel unencrypted over a network.
// A bare name such as dev12345 means https://dev12345.service-now.com, and a
// host without a scheme gets https://.
function normalizeInstance(value) {
  let raw = String(value).trim();
  if (/^[a-z0-9][a-z0-9-]*$/i.test(raw)) raw = `https://${raw}.service-now.com`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`The instance URL is not valid: ${String(value)}`);
  }
  if (url.username || url.password) {
    throw new ToolError('The instance URL must not contain a user name or password.');
  }
  const okScheme = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname));
  if (!okScheme) {
    throw new ToolError('The instance URL must start with https://');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function parsePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ToolError(`The redirect port must be a number from 1 to 65535, got: ${String(value)}`);
  }
  return n;
}

// There is no built-in instance. It comes from --instance, SN_INSTANCE or the
// config file that login saves. Only status may run without one.
function loadConfig(overrides = {}, { requireInstance = true } = {}) {
  const env = process.env;
  const configFile = configFilePath();
  const file = readJsonFile(configFile) || {};

  const rawInstance = String(overrides.instance || env.SN_INSTANCE || file.instance || '').trim();
  if (!rawInstance && requireInstance) {
    throw new ToolError(`No ServiceNow instance is set. Run \`${loginCommand()} --instance https://<your-instance>.service-now.com --client-id <id>\` or set SN_INSTANCE.`, { auth: true });
  }
  const instance = rawInstance ? normalizeInstance(rawInstance) : '';
  const clientId = String(overrides.clientId || env.SN_CLIENT_ID || file.clientId || '').trim();
  // Only for OAuth clients that were registered with a secret. Read from the
  // environment on every start and never written to disk.
  const clientSecret = String(env.SN_CLIENT_SECRET || '').trim();
  const redirectPort = parsePort(overrides.port || env.SN_REDIRECT_PORT || file.redirectPort || DEFAULT_PORT);

  // Writes are allowed only when the value is exactly 1.
  let allowWrite;
  if (env.SN_ALLOW_WRITE !== undefined && env.SN_ALLOW_WRITE !== '') {
    allowWrite = env.SN_ALLOW_WRITE === '1';
  } else {
    allowWrite = file.allowWrite === true || file.allowWrite === 1 || file.allowWrite === '1';
  }

  return {
    instance,
    clientId,
    clientSecret,
    redirectPort,
    redirectUri: `http://localhost:${redirectPort}/callback`,
    allowWrite,
    configFile,
    tokenFile: tokenFilePath(),
  };
}

// Write a file that only the current user can read. The folder is created
// with mode 0700 and the file with mode 0600. The write is atomic: a temp
// file is written first and then renamed over the target.
function writePrivateFile(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

function saveConfig(cfg) {
  const current = readJsonFile(cfg.configFile) || {};
  const next = { ...current, instance: cfg.instance, clientId: cfg.clientId, redirectPort: cfg.redirectPort };
  writePrivateFile(cfg.configFile, `${JSON.stringify(next, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Token file
// ---------------------------------------------------------------------------

function readTokens(cfg) {
  const tokens = readJsonFile(cfg.tokenFile);
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) return null;
  remember(tokens.access_token);
  remember(tokens.refresh_token);
  return tokens;
}

function saveTokens(cfg, tokens) {
  remember(tokens.access_token);
  remember(tokens.refresh_token);
  writePrivateFile(cfg.tokenFile, `${JSON.stringify(tokens, null, 2)}\n`);
}

function tokensMatchInstance(tokens, cfg) {
  if (!tokens.instance) return true;
  try {
    return normalizeInstance(tokens.instance) === cfg.instance;
  } catch {
    return false;
  }
}

function expiresSoon(tokens) {
  return typeof tokens.expires_at === 'number' && tokens.expires_at - Date.now() <= REFRESH_MARGIN_MS;
}

function loginCommand() {
  const shown = /\s/.test(SELF_PATH) ? `"${SELF_PATH}"` : SELF_PATH;
  return `node ${shown} login`;
}

function notSignedIn(reason) {
  return new ToolError(`${reason} Run \`${loginCommand()}\` first.`, { auth: true });
}

// ---------------------------------------------------------------------------
// OAuth: authorization code with PKCE for a public client, and refresh
// ---------------------------------------------------------------------------

function makePkce() {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 url safe characters
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function describeNetworkError(cfg, err) {
  if (err instanceof ToolError) return err;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new ToolError(`The request to ${cfg.instance} timed out after ${HTTP_TIMEOUT_MS / 1000} seconds.`, { network: true });
  }
  const cause = err && err.cause ? (err.cause.code || err.cause.message || '') : '';
  const extra = cause ? ` (${cause})` : '';
  return new ToolError(`Could not reach ${cfg.instance}${extra}. Check the instance URL and your connection.`, { network: true });
}

// POST to the token endpoint. Returns the parsed token response.
// Error text only ever uses the error fields of the reply, never the body.
async function postToken(cfg, params) {
  let res;
  let text;
  if (cfg.clientSecret) {
    remember(cfg.clientSecret);
    params = { ...params, client_secret: cfg.clientSecret };
  }
  try {
    res = await fetch(`${cfg.instance}/oauth_token.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw describeNetworkError(cfg, err);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (json && typeof json === 'object') {
    remember(json.access_token);
    remember(json.refresh_token);
  }
  if (!res.ok || !json || typeof json.access_token !== 'string' || !json.access_token) {
    let reason = '';
    if (json && typeof json.error === 'string') {
      reason = [json.error, json.error_description].filter((part) => typeof part === 'string' && part).join(': ');
    } else if (json && json.error && typeof json.error === 'object') {
      reason = [json.error.message, json.error.detail].filter((part) => typeof part === 'string' && part).join(': ');
    }
    if (!reason) reason = res.ok ? 'the reply had no access token' : 'no details given';
    throw new ToolError(`The token request was rejected (status ${res.status}): ${reason}`, { status: res.status, auth: true });
  }
  return json;
}

function tokensFromResponse(cfg, json, previous = {}) {
  const seconds = Number(json.expires_in);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || previous.refresh_token || null,
    expires_at: Number.isFinite(seconds) && seconds > 0 ? Date.now() + Math.round(seconds * 1000) : null,
    scope: json.scope ?? previous.scope ?? null,
    token_type: json.token_type || previous.token_type || 'Bearer',
    instance: cfg.instance,
    client_id: previous.client_id || cfg.clientId,
  };
}

// Only one refresh runs at a time. Calls that arrive meanwhile share it.
let refreshInFlight = null;

function refreshTokens(cfg, tokens) {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(cfg, tokens).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh(cfg, tokens) {
  const clientId = tokens.client_id || cfg.clientId;
  if (!tokens.refresh_token || !clientId) {
    throw notSignedIn('The ServiceNow sign in has expired and cannot be renewed.');
  }
  let json;
  try {
    json = await postToken(cfg, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
  } catch (err) {
    if (err.network) throw err;
    throw notSignedIn(`The ServiceNow sign in could not be renewed. ${err.message}.`);
  }
  const next = tokensFromResponse(cfg, json, { ...tokens, client_id: clientId });
  saveTokens(cfg, next);
  return next;
}

// Load the saved tokens and renew them first when they are about to expire.
async function currentTokens(cfg) {
  const tokens = readTokens(cfg);
  if (!tokens) throw notSignedIn('Not signed in to ServiceNow.');
  if (!tokensMatchInstance(tokens, cfg)) {
    throw notSignedIn(`The saved sign in is for ${tokens.instance}, but this server is set up for ${cfg.instance}.`);
  }
  if (expiresSoon(tokens)) return refreshTokens(cfg, tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// ServiceNow REST calls
// ---------------------------------------------------------------------------

async function rawFetch(cfg, accessToken, method, urlPath, options = {}) {
  const url = new URL(cfg.instance + urlPath);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: options.accept || 'application/json',
  };
  if (options.body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
  try {
    // Redirects are not followed, so the token is never sent to another host.
    return await fetch(url, {
      method,
      headers,
      body: options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw describeNetworkError(cfg, err);
  }
}

async function readBody(cfg, res) {
  try {
    return await res.text();
  } catch (err) {
    throw describeNetworkError(cfg, err);
  }
}

async function discardBody(res) {
  try {
    if (res.body) await res.body.cancel();
  } catch { /* nothing useful to do */ }
}

function httpError(status, text) {
  let message = '';
  let detail = '';
  try {
    const body = JSON.parse(text);
    if (body && body.error && typeof body.error === 'object') {
      if (typeof body.error.message === 'string') message = body.error.message;
      if (typeof body.error.detail === 'string') detail = body.error.detail;
    } else if (body && typeof body.error === 'string') {
      message = body.error;
      if (typeof body.error_description === 'string') detail = body.error_description;
    }
  } catch { /* not JSON */ }
  if (!message) {
    const plain = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    message = plain ? plain.slice(0, 200) : 'no details given';
  }
  let summary = `ServiceNow returned status ${status}: ${message}`;
  if (status === 401) summary += `. Run \`${loginCommand()}\` again.`;
  return new ToolError(summary, { status, detail, auth: status === 401 });
}

// One authorized request. Renews the token up front when it is about to
// expire, and renews and retries exactly once after a 401.
async function snRequest(cfg, method, urlPath, options = {}) {
  let tokens = await currentTokens(cfg);
  let res = await rawFetch(cfg, tokens.access_token, method, urlPath, options);

  if (res.status === 401) {
    await discardBody(res);
    const latest = readTokens(cfg);
    const renewedElsewhere = latest
      && latest.access_token !== tokens.access_token
      && tokensMatchInstance(latest, cfg)
      && !expiresSoon(latest);
    tokens = renewedElsewhere ? latest : await refreshTokens(cfg, latest && tokensMatchInstance(latest, cfg) ? latest : tokens);
    res = await rawFetch(cfg, tokens.access_token, method, urlPath, options);
  }

  if (res.status >= 300 && res.status < 400) {
    let where = '';
    try {
      const target = new URL(res.headers.get('location') || '', cfg.instance);
      where = ` to ${target.origin}${target.pathname}`;
    } catch { /* no usable location */ }
    await discardBody(res);
    throw new ToolError(
      `ServiceNow answered with a redirect${where} instead of data (status ${res.status}). The instance may be asleep, or the instance URL may be wrong.`,
      { status: res.status },
    );
  }
  return res;
}

// An authorized request that expects JSON back.
async function snJson(cfg, method, urlPath, options = {}) {
  const res = await snRequest(cfg, method, urlPath, options);
  const text = await readBody(cfg, res);
  if (!res.ok) throw httpError(res.status, text);
  if (!text.trim()) return { data: null, res };
  try {
    return { data: JSON.parse(text), res };
  } catch {
    throw new ToolError(
      `ServiceNow sent a reply that is not JSON (status ${res.status}). The instance may be asleep, or the instance URL may be wrong.`,
      { status: res.status },
    );
  }
}

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String(value.display_value ?? value.value ?? '');
  return String(value);
}

// Who is signed in. Tries the current user endpoint first, then falls back
// to a query on sys_user.
async function whoAmI(cfg) {
  try {
    const { data } = await snJson(cfg, 'GET', '/api/now/ui/user/current_user');
    const r = (data && data.result) || {};
    const user = {
      sys_id: asText(r.user_sys_id || r.sys_id),
      user_name: asText(r.user_name),
      name: asText(r.user_display_name || r.name),
    };
    if (user.sys_id || user.user_name) return user;
  } catch (err) {
    if (!(err instanceof ToolError) || err.auth || err.network) throw err;
  }
  const { data } = await snJson(cfg, 'GET', '/api/now/table/sys_user', {
    query: {
      sysparm_query: 'user_name=javascript:gs.getUserName()',
      sysparm_limit: 1,
      sysparm_fields: 'sys_id,user_name,name',
    },
  });
  const row = data && Array.isArray(data.result) ? data.result[0] : null;
  if (!row) throw new ToolError('ServiceNow did not say who is signed in.');
  return { sys_id: asText(row.sys_id), user_name: asText(row.user_name), name: asText(row.name) };
}

// Best effort. Returns an empty string when the property cannot be read.
async function buildTag(cfg) {
  try {
    const { data } = await snJson(cfg, 'GET', '/api/now/table/sys_properties', {
      query: { sysparm_query: 'name=glide.buildtag.last', sysparm_fields: 'value', sysparm_limit: 1 },
    });
    const row = data && Array.isArray(data.result) ? data.result[0] : null;
    return row ? asText(row.value) : '';
  } catch (err) {
    if (err instanceof ToolError && err.auth) throw err;
    return '';
  }
}

// ---------------------------------------------------------------------------
// Argument checks. Each one throws a ToolError with a plain message.
// ---------------------------------------------------------------------------

function argTable(value, key = 'table') {
  if (typeof value !== 'string' || !TABLE_RE.test(value)) {
    throw new ToolError(`${key} must be a table name made of lowercase letters, digits and underscores, for example incident.`);
  }
  return value;
}

function argSysId(value, key = 'sys_id') {
  if (typeof value !== 'string' || !SYS_ID_RE.test(value)) {
    throw new ToolError(`${key} must be a sys_id: exactly 32 hex characters.`);
  }
  return value.toLowerCase();
}

function argInt(value, key, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  let n = value;
  if (typeof n === 'string' && /^\d+$/.test(n.trim())) n = Number(n.trim());
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new ToolError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function argText(value, key) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError(`${key} must be a string.`);
  return value;
}

function argBool(value, key) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new ToolError(`${key} must be true or false.`);
  return value;
}

function argFields(value) {
  const text = argText(value, 'fields');
  if (text === undefined || !text.trim()) return undefined;
  const list = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (!list.every((field) => FIELD_RE.test(field))) {
    throw new ToolError('fields must be a comma separated list of column names, for example number,short_description.');
  }
  return list.join(',');
}

function argDisplayValue(value) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'boolean' ? String(value) : value;
  if (text !== 'true' && text !== 'false' && text !== 'all') {
    throw new ToolError('display_value must be one of: true, false, all.');
  }
  return text;
}

function argOrderBy(value) {
  const text = argText(value, 'order_by');
  if (text === undefined || !text.trim()) return undefined;
  if (!FIELD_RE.test(text.trim())) {
    throw new ToolError('order_by must be a single column name, for example sys_created_on, or DESCsys_created_on for newest first.');
  }
  return text.trim();
}

function argAbsolutePath(value, key) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new ToolError(`${key} must be an absolute local path, for example /Users/me/Downloads/file.pdf.`);
  }
  return path.normalize(value);
}

function argRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('record must be an object of field names and values.');
  }
  return value;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const CONTENT_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
  '.json': 'application/json', '.xml': 'application/xml', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function attachmentSummary(row) {
  const r = row || {};
  return {
    sys_id: asText(r.sys_id),
    file_name: asText(r.file_name),
    content_type: asText(r.content_type),
    size_bytes: asText(r.size_bytes),
    table_name: asText(r.table_name),
    table_sys_id: asText(r.table_sys_id),
    sys_created_on: asText(r.sys_created_on),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const WRITE_NOTE = 'This is a write tool. It refuses to run unless the server was started with SN_ALLOW_WRITE=1.';

const SCHEMA_TABLE = { type: 'string', description: 'Table name, lowercase letters, digits and underscores only. Example: incident.' };
const SCHEMA_SYS_ID = { type: 'string', description: 'The sys_id of the record: 32 hex characters.' };
const SCHEMA_FIELDS = { type: 'string', description: 'Comma separated list of columns to return. Example: number,short_description,state. Leave out to get every column.' };
const SCHEMA_DISPLAY = {
  type: 'string',
  enum: ['true', 'false', 'all'],
  description: 'false returns stored values (the default), true returns display values such as names for references, all returns both.',
};

const TOOLS = [
  {
    name: 'sn_instance_info',
    write: false,
    description: 'Show which ServiceNow instance this server talks to, who is signed in, the instance build tag, and whether write tools are allowed. A good first call to check that the connection works.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(args, cfg) {
      const user = await whoAmI(cfg);
      const build = await buildTag(cfg);
      return {
        instance: cfg.instance,
        user: { name: user.name, user_name: user.user_name, sys_id: user.sys_id },
        build,
        writes_allowed: cfg.allowWrite,
      };
    },
  },
  {
    name: 'sn_table_query',
    write: false,
    description: 'Read records from a ServiceNow table with the Table API. Returns count (records in this reply), total (all matching records, when the instance reports it) and records. Use limit and offset to page through large results.',
    inputSchema: {
      type: 'object',
      properties: {
        table: SCHEMA_TABLE,
        query: { type: 'string', description: 'ServiceNow encoded query. Example: active=true^priority=1. Leave out to match every record.' },
        fields: SCHEMA_FIELDS,
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'How many records to return. Default 20, at most 200.' },
        offset: { type: 'integer', minimum: 0, description: 'How many records to skip, for paging. Default 0.' },
        display_value: SCHEMA_DISPLAY,
        order_by: { type: 'string', description: 'Column to sort by, oldest or smallest first. Put DESC in front for the reverse order. Example: DESCsys_created_on.' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, cfg) {
      const table = argTable(args.table);
      const limit = argInt(args.limit, 'limit', { min: 1, max: 200, fallback: 20 });
      const offset = argInt(args.offset, 'offset', { min: 0, max: 1000000000, fallback: undefined });
      const fields = argFields(args.fields);
      const displayValue = argDisplayValue(args.display_value);
      const orderBy = argOrderBy(args.order_by);
      let query = argText(args.query, 'query') || '';
      if (orderBy) query = query ? `${query}^ORDERBY${orderBy}` : `ORDERBY${orderBy}`;

      const { data, res } = await snJson(cfg, 'GET', `/api/now/table/${table}`, {
        query: {
          sysparm_query: query,
          sysparm_fields: fields,
          sysparm_limit: limit,
          sysparm_offset: offset,
          sysparm_display_value: displayValue,
          sysparm_exclude_reference_link: 'true',
        },
      });
      const records = data && Array.isArray(data.result) ? data.result : [];
      const out = { count: records.length };
      const total = res.headers.get('x-total-count');
      if (total !== null && total !== '' && Number.isFinite(Number(total))) out.total = Number(total);
      out.records = records;
      return out;
    },
  },
  {
    name: 'sn_table_get',
    write: false,
    description: 'Read one record from a ServiceNow table by its sys_id.',
    inputSchema: {
      type: 'object',
      properties: { table: SCHEMA_TABLE, sys_id: SCHEMA_SYS_ID, fields: SCHEMA_FIELDS, display_value: SCHEMA_DISPLAY },
      required: ['table', 'sys_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, cfg) {
      const table = argTable(args.table);
      const sysId = argSysId(args.sys_id);
      const fields = argFields(args.fields);
      const displayValue = argDisplayValue(args.display_value);
      const { data } = await snJson(cfg, 'GET', `/api/now/table/${table}/${sysId}`, {
        query: {
          sysparm_fields: fields,
          sysparm_display_value: displayValue,
          sysparm_exclude_reference_link: 'true',
        },
      });
      return { record: data ? data.result ?? null : null };
    },
  },
  {
    name: 'sn_table_schema',
    write: false,
    description: 'List the columns defined on a ServiceNow table, read from sys_dictionary: column name, label, type, max length, whether it is mandatory, and the table a reference points to. Columns inherited from a parent table (for example task for incident) are listed under the parent table name.',
    inputSchema: {
      type: 'object',
      properties: { table: SCHEMA_TABLE },
      required: ['table'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, cfg) {
      const table = argTable(args.table);
      const { data } = await snJson(cfg, 'GET', '/api/now/table/sys_dictionary', {
        query: {
          sysparm_query: `name=${table}^elementISNOTEMPTY`,
          sysparm_fields: 'element,column_label,internal_type,max_length,mandatory,reference',
          sysparm_limit: 500,
          sysparm_exclude_reference_link: 'true',
        },
      });
      const columns = data && Array.isArray(data.result) ? data.result : [];
      return { table, count: columns.length, columns };
    },
  },
  {
    name: 'sn_attachment_list',
    write: false,
    description: 'List file attachments. Give table and sys_id to see the attachments of one record, or only table for every attachment on that table. Returns sys_id, file_name, content_type, size_bytes, table_name, table_sys_id and sys_created_on for each.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table the attachments belong to. Example: incident.' },
        sys_id: { type: 'string', description: 'The sys_id of the record the attachments belong to: 32 hex characters.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'How many attachments to return. Default 20, at most 200.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, cfg) {
      const parts = [];
      if (args.table !== undefined && args.table !== null) parts.push(`table_name=${argTable(args.table)}`);
      if (args.sys_id !== undefined && args.sys_id !== null) parts.push(`table_sys_id=${argSysId(args.sys_id)}`);
      const limit = argInt(args.limit, 'limit', { min: 1, max: 200, fallback: 20 });
      const { data, res } = await snJson(cfg, 'GET', '/api/now/attachment', {
        query: { sysparm_query: parts.join('^'), sysparm_limit: limit },
      });
      const attachments = (data && Array.isArray(data.result) ? data.result : []).map(attachmentSummary);
      const out = { count: attachments.length };
      const total = res.headers.get('x-total-count');
      if (total !== null && total !== '' && Number.isFinite(Number(total))) out.total = Number(total);
      out.attachments = attachments;
      return out;
    },
  },
  {
    name: 'sn_attachment_download',
    write: false,
    description: 'Download one attachment from ServiceNow and save it to a local file. Returns the path and size only, never the file contents. Refuses to replace an existing file unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        sys_id: { type: 'string', description: 'The sys_id of the attachment (from sn_attachment_list): 32 hex characters.' },
        save_to: { type: 'string', description: 'Absolute local path to save the file to. The folder must already exist.' },
        overwrite: { type: 'boolean', default: false, description: 'Set to true to replace a file that already exists at save_to.' },
      },
      required: ['sys_id', 'save_to'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args, cfg) {
      const sysId = argSysId(args.sys_id);
      const target = argAbsolutePath(args.save_to, 'save_to');
      const overwrite = argBool(args.overwrite, 'overwrite');
      const dir = path.dirname(target);
      if (!isDirectory(dir)) throw new ToolError(`The folder ${dir} does not exist.`);
      if (isDirectory(target)) throw new ToolError(`${target} is a folder. save_to must be a file path.`);
      if (fs.existsSync(target) && !overwrite) {
        throw new ToolError(`${target} already exists. Pass overwrite: true to replace it.`);
      }

      // The file endpoint returns raw bytes, so any content type is accepted
      // here. Errors still come back as JSON.
      const res = await snRequest(cfg, 'GET', `/api/now/attachment/${sysId}/file`, {
        accept: 'application/json, */*;q=0.8',
      });
      if (!res.ok) throw httpError(res.status, await readBody(cfg, res));

      const tmp = `${target}.part-${crypto.randomBytes(4).toString('hex')}`;
      let size = 0;
      try {
        const handle = await fs.promises.open(tmp, 'wx');
        try {
          if (res.body) {
            for await (const chunk of res.body) {
              await handle.write(chunk);
              size += chunk.length;
            }
          }
        } finally {
          await handle.close();
        }
        if (!overwrite && fs.existsSync(target)) {
          throw new ToolError(`${target} already exists. Pass overwrite: true to replace it.`);
        }
        fs.renameSync(tmp, target);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
        if (err instanceof ToolError) throw err;
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw describeNetworkError(cfg, err);
        throw new ToolError(`Could not save the file to ${target}: ${err && err.code ? err.code : 'write failed'}.`);
      }
      return { path: target, size_bytes: size, content_type: res.headers.get('content-type') || '' };
    },
  },
  {
    name: 'sn_table_create',
    write: true,
    description: `Create a new record in a ServiceNow table. ${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        table: SCHEMA_TABLE,
        record: { type: 'object', additionalProperties: true, description: 'Field names and values for the new record. Example: {"short_description": "Printer is down"}.' },
      },
      required: ['table', 'record'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args, cfg) {
      const table = argTable(args.table);
      const record = argRecord(args.record);
      const { data } = await snJson(cfg, 'POST', `/api/now/table/${table}`, {
        query: { sysparm_exclude_reference_link: 'true' },
        body: JSON.stringify(record),
      });
      return { created: true, record: data ? data.result ?? null : null };
    },
  },
  {
    name: 'sn_table_update',
    write: true,
    description: `Change fields on one existing record. Only the fields you send are changed. ${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        table: SCHEMA_TABLE,
        sys_id: SCHEMA_SYS_ID,
        record: { type: 'object', additionalProperties: true, description: 'Field names and new values. Fields left out stay as they are.' },
      },
      required: ['table', 'sys_id', 'record'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(args, cfg) {
      const table = argTable(args.table);
      const sysId = argSysId(args.sys_id);
      const record = argRecord(args.record);
      const { data } = await snJson(cfg, 'PATCH', `/api/now/table/${table}/${sysId}`, {
        query: { sysparm_exclude_reference_link: 'true' },
        body: JSON.stringify(record),
      });
      return { updated: true, record: data ? data.result ?? null : null };
    },
  },
  {
    name: 'sn_table_delete',
    write: true,
    description: `Delete one record from a ServiceNow table. This cannot be undone. ${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { table: SCHEMA_TABLE, sys_id: SCHEMA_SYS_ID },
      required: ['table', 'sys_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async run(args, cfg) {
      const table = argTable(args.table);
      const sysId = argSysId(args.sys_id);
      await snJson(cfg, 'DELETE', `/api/now/table/${table}/${sysId}`);
      return { deleted: true, table, sys_id: sysId };
    },
  },
  {
    name: 'sn_attachment_upload',
    write: true,
    description: `Upload a local file and attach it to a ServiceNow record. ${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table of the record to attach the file to. Example: incident.' },
        sys_id: { type: 'string', description: 'The sys_id of the record to attach the file to: 32 hex characters.' },
        file_path: { type: 'string', description: 'Absolute local path of the file to upload.' },
        file_name: { type: 'string', description: 'Name to give the attachment. Default: the name of the local file.' },
        content_type: { type: 'string', description: 'MIME type of the file. Default: guessed from the file extension.' },
      },
      required: ['table', 'sys_id', 'file_path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args, cfg) {
      const table = argTable(args.table);
      const sysId = argSysId(args.sys_id);
      const filePath = argAbsolutePath(args.file_path, 'file_path');
      const fileName = (argText(args.file_name, 'file_name') || '').trim() || path.basename(filePath);
      if (/[\\/\0]/.test(fileName)) throw new ToolError('file_name must be a plain file name without slashes.');
      const given = (argText(args.content_type, 'content_type') || '').trim();
      if (given && !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(given)) {
        throw new ToolError('content_type must look like a MIME type, for example application/pdf.');
      }
      const contentType = given || CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
      let bytes;
      try {
        if (!fs.statSync(filePath).isFile()) throw new Error('not a file');
        bytes = fs.readFileSync(filePath);
      } catch {
        throw new ToolError(`Could not read the file ${filePath}.`);
      }
      const { data } = await snJson(cfg, 'POST', '/api/now/attachment/file', {
        query: { table_name: table, table_sys_id: sysId, file_name: fileName },
        body: bytes,
        contentType,
      });
      return { uploaded: true, attachment: attachmentSummary(data ? data.result : null) };
    },
  },
  {
    name: 'sn_attachment_delete',
    write: true,
    description: `Delete one attachment from ServiceNow. This cannot be undone. ${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { sys_id: { type: 'string', description: 'The sys_id of the attachment to delete: 32 hex characters.' } },
      required: ['sys_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async run(args, cfg) {
      const sysId = argSysId(args.sys_id);
      await snJson(cfg, 'DELETE', `/api/now/attachment/${sysId}`);
      return { deleted: true, sys_id: sysId };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolOk(value) {
  return { content: [{ type: 'text', text: scrub(JSON.stringify(value, null, 2)) }] };
}

function toolFail(err) {
  const payload = {};
  if (err instanceof ToolError) {
    payload.error = scrubError(err.message);
    if (err.status) payload.status = err.status;
    if (err.detail) payload.detail = scrubError(err.detail);
  } else {
    logError(`unexpected error: ${err && err.stack ? err.stack : String(err)}`);
    payload.error = `Unexpected error: ${scrubError(err && err.message ? err.message : String(err))}`;
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

async function callTool(params) {
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    throw new RpcError(-32602, 'tools/call needs a tool name');
  }
  const tool = TOOLS_BY_NAME.get(params.name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  try {
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new ToolError('The tool arguments must be an object.');
    }
    const cfg = loadConfig();
    if (tool.write && !cfg.allowWrite) {
      throw new ToolError(`Writes are turned off, so ${tool.name} did nothing. It only runs when SN_ALLOW_WRITE=1 is set where this server is registered.`);
    }
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, key)) {
        const known = Object.keys(tool.inputSchema.properties).join(', ') || 'none';
        throw new ToolError(`Unknown argument: ${key}. This tool accepts: ${known}.`);
      }
    }
    for (const key of tool.inputSchema.required || []) {
      if (args[key] === undefined || args[key] === null) throw new ToolError(`Missing required argument: ${key}.`);
    }
    return toolOk(await tool.run(args, cfg));
  } catch (err) {
    return toolFail(err);
  }
}

// ---------------------------------------------------------------------------
// MCP over stdio: newline delimited JSON-RPC 2.0
// ---------------------------------------------------------------------------

const INSTRUCTIONS = 'servicenow-mcp gives access to one ServiceNow instance through its REST API: query tables, read single records, look up the columns of a table, and list or download attachments. It is read-only unless the server was started with SN_ALLOW_WRITE=1; without that the create, update, delete and upload tools refuse to run. If a tool reports that nobody is signed in, ask the user to run the login command shown in the error.';

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      const wanted = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      };
    case 'tools/call':
      return callTool(params);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
  if (typeof msg.method !== 'string') {
    // A reply to something this server never asked. Nothing to do.
    if ('result' in msg || 'error' in msg) return undefined;
    return rpcError(hasId ? msg.id : null, -32600, 'Invalid Request');
  }
  // No id means a notification, which never gets a reply.
  if (!hasId) return undefined;
  try {
    const result = await dispatch(msg.method, msg.params);
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(msg.id, err.code, err.message);
    logError(`internal error: ${err && err.stack ? err.stack : String(err)}`);
    return rpcError(msg.id, -32603, 'Internal error');
  }
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (Array.isArray(msg)) {
    if (msg.length === 0) return rpcError(null, -32600, 'Invalid Request');
    const replies = (await Promise.all(msg.map(handleMessage))).filter((reply) => reply !== undefined);
    return replies.length ? replies : undefined;
  }
  return handleMessage(msg);
}

function serve() {
  const pending = new Set();
  const send = (msg) => { process.stdout.write(`${JSON.stringify(msg)}\n`); };

  process.stdout.on('error', () => process.exit(0));
  process.on('uncaughtException', (err) => logError(`uncaught: ${err && err.stack ? err.stack : String(err)}`));
  process.on('unhandledRejection', (err) => logError(`unhandled: ${err && err.stack ? err.stack : String(err)}`));

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    // Each line is handled on its own, so a slow request never blocks the next.
    const work = handleLine(line)
      .then((reply) => { if (reply !== undefined) send(reply); })
      .catch((err) => logError(`failed to handle a message: ${err && err.stack ? err.stack : String(err)}`))
      .finally(() => pending.delete(work));
    pending.add(work);
  });
  rl.on('close', async () => {
    // Finish the requests that are still running, then leave.
    await Promise.allSettled([...pending]);
    exitAfterFlush(0);
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Exit only after everything written so far has left the process.
function exitAfterFlush(code) {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

function say(text = '') {
  process.stdout.write(`${scrub(text)}\n`);
}

function complain(text) {
  process.stderr.write(`${scrubError(text)}\n`);
}

function parseLoginArgs(argv) {
  const out = { open: true };
  const valueFlags = { '--client-id': 'clientId', '--instance': 'instance', '--port': 'port' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-open') { out.open = false; continue; }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!valueFlags[name]) throw new ToolError(`Unknown option for login: ${arg}`);
    const value = eq === -1 ? argv[i += 1] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new ToolError(`${name} needs a value.`);
    out[valueFlags[name]] = value;
  }
  return out;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function sendPage(res, status, title, body) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(title)}</title>`
    + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.25rem;color:#1b1b1b}h1{font-size:1.4rem;margin:0 0 .5rem}</style>'
    + `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
  return new Promise((resolve) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(html, resolve);
  });
}

function listenOn(handler, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// Ask one question on the terminal. Only used by login, and only when a
// person is at the keyboard.
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function cmdLogin(argv) {
  const opts = parseLoginArgs(argv);
  if (process.stdin.isTTY) {
    const known = loadConfig({ instance: opts.instance, clientId: opts.clientId }, { requireInstance: false });
    if (!known.instance) {
      opts.instance = await ask('ServiceNow instance (for example dev12345 or https://acme.service-now.com): ');
    }
    if (!known.clientId) {
      opts.clientId = await ask('OAuth client id (README.md explains how to create one): ');
    }
  }
  const cfg = loadConfig({ instance: opts.instance, clientId: opts.clientId, port: opts.port });
  if (!cfg.clientId) {
    throw new ToolError('No OAuth client id. Pass --client-id <id> or set SN_CLIENT_ID. See README.md for how to create the OAuth client on the instance.');
  }

  const { verifier, challenge } = makePkce();
  remember(verifier);
  const state = crypto.randomBytes(24).toString('base64url');
  const authUrl = `${cfg.instance}/oauth_auth.do?${new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()}`;

  const servers = [];
  let timer = null;
  let finish;
  const outcome = new Promise((resolve) => { finish = resolve; });
  let exchanging = false;

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', cfg.redirectUri);
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        await sendPage(res, 404, 'Not found', 'This address only handles the ServiceNow sign in.');
        return;
      }
      const q = url.searchParams;
      const gotState = q.get('state');
      const stateOk = gotState !== null && sameString(gotState, state);
      const error = q.get('error');

      // An error reply counts when it carries our state, or no state at all.
      if (error && (stateOk || gotState === null)) {
        const detail = q.get('error_description');
        const message = `ServiceNow refused the sign in: ${error}${detail ? ` (${detail})` : ''}`;
        await sendPage(res, 400, 'Sign in failed', `${message}. You can close this tab.`);
        finish({ ok: false, message });
        return;
      }
      if (!stateOk) {
        await sendPage(res, 400, 'Sign in not completed', 'The state value did not match this sign in. Go back to the terminal and use the link printed there.');
        return;
      }
      const code = q.get('code');
      if (!code) {
        await sendPage(res, 400, 'Sign in not completed', 'ServiceNow did not send an authorization code.');
        return;
      }
      if (exchanging) {
        await sendPage(res, 409, 'Sign in already in progress', 'You can close this tab.');
        return;
      }
      exchanging = true;
      remember(code);

      try {
        const json = await postToken(cfg, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: cfg.redirectUri,
          client_id: cfg.clientId,
          code_verifier: verifier,
        });
        saveTokens(cfg, tokensFromResponse(cfg, json));
        saveConfig(cfg);
      } catch (err) {
        const message = `Sign in failed. ${err instanceof ToolError ? err.message : 'The tokens could not be saved.'}`;
        await sendPage(res, 502, 'Sign in failed', `${scrubError(message)} You can close this tab.`);
        finish({ ok: false, message });
        return;
      }
      await sendPage(res, 200, 'Signed in', 'You can close this tab and go back to the terminal.');
      finish({ ok: true });
    } catch (err) {
      try { res.destroy(); } catch { /* already gone */ }
      logError(`callback error: ${err && err.message ? err.message : String(err)}`);
    }
  };

  try {
    servers.push(await listenOn(handler, cfg.redirectPort, '127.0.0.1'));
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      throw new ToolError(`Port ${cfg.redirectPort} is already in use. Close the program that uses it, or pick another port with --port (the redirect URL on the OAuth client must then use the same port).`);
    }
    throw new ToolError(`Could not listen on port ${cfg.redirectPort}: ${err && err.code ? err.code : 'unknown error'}.`);
  }
  // Browsers may reach "localhost" over IPv6, so answer there too when possible.
  try {
    servers.push(await listenOn(handler, cfg.redirectPort, '::1'));
  } catch { /* IPv6 loopback is not available. 127.0.0.1 is enough. */ }

  say(`Signing in to ${cfg.instance}`);
  say('Open this URL in your browser to sign in:');
  say('');
  say(authUrl);
  say('');
  say(`Waiting for the sign in to finish (gives up after ${Math.round(LOGIN_TIMEOUT_MS / 60000) || 1} minutes)...`);

  if (opts.open) {
    execFile('open', [authUrl], (err) => {
      if (err) complain('Could not open the browser automatically. Open the URL above by hand.');
    });
  }

  timer = setTimeout(() => {
    finish({ ok: false, message: 'Timed out waiting for the sign in to finish in the browser. Nothing was saved. Run the login command again when you are ready.' });
  }, LOGIN_TIMEOUT_MS);

  const result = await outcome;
  clearTimeout(timer);
  for (const server of servers) {
    server.close();
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  }

  if (!result.ok) {
    complain(result.message);
    return 1;
  }

  try {
    const user = await whoAmI(cfg);
    say(`Signed in to ${cfg.instance} as ${user.name || user.user_name || 'unknown user'}`);
  } catch (err) {
    say(`Signed in to ${cfg.instance}`);
    complain(`Note: the tokens were saved, but the user name could not be read. ${err instanceof ToolError ? err.message : ''}`.trim());
  }
  say(`Tokens saved to ${cfg.tokenFile}`);
  return 0;
}

function describeExpiry(tokens) {
  if (typeof tokens.expires_at !== 'number') return 'unknown';
  const when = new Date(tokens.expires_at).toISOString();
  const minutes = Math.round((tokens.expires_at - Date.now()) / 60000);
  if (tokens.expires_at <= Date.now()) {
    return `${when} (expired${tokens.refresh_token ? ', will be renewed on next use' : ''})`;
  }
  return `${when} (in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'})`;
}

function cmdStatus() {
  const cfg = loadConfig({}, { requireInstance: false });
  const tokens = readTokens(cfg);
  say(`Instance:        ${cfg.instance || 'not set'}`);
  say(`Client id:       ${cfg.clientId || 'not set'}`);
  if (!tokens) {
    say('Signed in:       no');
    say('Token expires:   not signed in');
  } else if (!cfg.instance || !tokensMatchInstance(tokens, cfg)) {
    say(`Signed in:       no (the saved sign in is for ${tokens.instance || 'an unknown instance'})`);
    say('Token expires:   not signed in');
  } else {
    say('Signed in:       yes');
    say(`Token expires:   ${describeExpiry(tokens)}`);
  }
  say(`Writes allowed:  ${cfg.allowWrite ? 'yes (SN_ALLOW_WRITE=1)' : 'no (read-only)'}`);
  say(`Token file:      ${cfg.tokenFile}`);
  say(`Config file:     ${cfg.configFile}`);
  if (!tokens) say(`To sign in run:  ${loginCommand()} --instance <url> --client-id <id>`);
  return 0;
}

function cmdLogout() {
  const file = tokenFilePath();
  try {
    fs.unlinkSync(file);
    say(`Signed out. Removed ${file}`);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      say('Already signed out. There was no token file.');
    } else {
      throw new ToolError(`Could not remove ${file}: ${err && err.code ? err.code : 'unknown error'}.`);
    }
  }
  return 0;
}

const USAGE = `servicenow-mcp ${SERVER_VERSION}

Usage: node server.mjs [command]

  serve     Run as an MCP server over stdio (the default when no command is given)
  login     Sign in to ServiceNow in the browser
            Options: --instance <url or name>  --client-id <id>  --port <n>  --no-open
            Asks for the instance and client id when they are missing
  status    Show the instance, whether you are signed in, and whether writes are allowed
  logout    Delete the saved tokens
  help      Show this text
`;

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18 || typeof fetch !== 'function') {
    process.stderr.write('servicenow-mcp needs Node 18 or newer.\n');
    process.exit(1);
  }
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === 'serve') {
    serve();
    return;
  }
  let code;
  try {
    switch (command) {
      case 'login': code = await cmdLogin(rest); break;
      case 'status': code = cmdStatus(); break;
      case 'logout': code = cmdLogout(); break;
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        code = 0;
        break;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
        code = 2;
    }
  } catch (err) {
    complain(`Error: ${err instanceof ToolError ? err.message : (err && err.message) || String(err)}`);
    code = 1;
  }
  exitAfterFlush(code);
}

main();
