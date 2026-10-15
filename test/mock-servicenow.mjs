// A local stand in for the ServiceNow endpoints that server.mjs uses.
// It listens on 127.0.0.1 on a random port and keeps everything in memory.
// Only for tests. It never talks to a real instance.

import http from 'node:http';
import crypto from 'node:crypto';

const hex32 = () => crypto.randomBytes(16).toString('hex');
const secret = () => crypto.randomBytes(24).toString('hex');
const sha256url = (text) => crypto.createHash('sha256').update(text).digest('base64url');

// Which columns point at another table, so display values can be shown.
const REFERENCES = { incident: { caller_id: 'sys_user', assigned_to: 'sys_user' } };

// Columns every table has. ServiceNow sets these itself and ignores them in writes.
const SYSTEM_COLUMNS = ['sys_id', 'sys_created_on', 'sys_created_by', 'sys_mod_count', 'sys_updated_on', 'sys_updated_by'];

// A clock that moves one second per write, so sys_updated_on always changes.
let clock = Date.UTC(2026, 8, 1, 8, 0, 0);
const tick = () => {
  clock += 1000;
  return new Date(clock).toISOString().replace('T', ' ').slice(0, 19);
};

function seedTables(user, other) {
  const inc = (number, short, priority, state, caller) => ({
    sys_id: hex32(), number, short_description: short, priority, state, active: state === '7' ? 'false' : 'true',
    caller_id: caller, assigned_to: user.sys_id, sys_created_on: `2026-09-0${priority} 10:00:00`,
  });
  const col = (name, element, label, type, max, mandatory = 'false', reference = '') => ({
    sys_id: hex32(), name, element, column_label: label, internal_type: type, max_length: String(max), mandatory, reference,
  });
  return {
    incident: [
      inc('INC0000001', 'Printer on floor 2 is down', '1', '1', other.sys_id),
      inc('INC0000002', 'Cannot open the shared drive', '2', '2', other.sys_id),
      inc('INC0000003', 'New laptop request', '4', '1', user.sys_id),
      inc('INC0000004', 'Email is slow', '3', '7', user.sys_id),
      inc('INC0000005', 'Printer out of toner', '3', '1', other.sys_id),
    ],
    sys_user: [user, other],
    sys_properties: [
      { sys_id: hex32(), name: 'glide.buildtag.last', value: 'glide-mock-01-01-2026__patch0' },
      { sys_id: hex32(), name: 'glide.product.name', value: 'Mock' },
    ],
    sys_dictionary: [
      col('incident', '', 'Incident', 'collection', 40),
      col('incident', 'number', 'Number', 'string', 40),
      col('incident', 'short_description', 'Short description', 'string', 160, 'true'),
      col('incident', 'caller_id', 'Caller', 'reference', 32, 'false', 'sys_user'),
      col('incident', 'priority', 'Priority', 'integer', 40),
      col('task', 'state', 'State', 'integer', 40),
    ],
  };
}

// Supports the small part of the encoded query language the tests need.
function runQuery(rows, query, userName) {
  const order = [];
  let out = rows.slice();
  for (const term of String(query || '').split('^')) {
    if (!term) continue;
    if (term.startsWith('ORDERBYDESC')) { order.push([term.slice(11), -1]); continue; }
    if (term.startsWith('ORDERBY')) { order.push([term.slice(7), 1]); continue; }
    let m = /^([a-z0-9_.]+)(ISNOTEMPTY|ISEMPTY)$/.exec(term);
    if (m) {
      const want = m[2] === 'ISNOTEMPTY';
      out = out.filter((row) => (String(row[m[1]] ?? '') !== '') === want);
      continue;
    }
    m = /^([a-z0-9_.]+)(!=|=|LIKE|STARTSWITH)(.*)$/.exec(term);
    if (!m) throw new Error(`Unsupported query term: ${term}`);
    const value = m[3] === 'javascript:gs.getUserName()' ? userName : m[3];
    out = out.filter((row) => {
      const have = String(row[m[1]] ?? '');
      if (m[2] === '=') return have === value;
      if (m[2] === '!=') return have !== value;
      if (m[2] === 'LIKE') return have.toLowerCase().includes(value.toLowerCase());
      return have.startsWith(value);
    });
  }
  for (const [field, dir] of order.reverse()) {
    out.sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * dir);
  }
  return out;
}

export async function startMock(options = {}) {
  const user = { sys_id: hex32(), user_name: 'ada.admin', name: 'Ada Admin' };
  const other = { sys_id: hex32(), user_name: 'bob.caller', name: 'Bob Caller' };
  const state = {
    clientId: options.clientId || 'mock-public-client',
    accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? 1800,
    denyNextAuthorize: false, // the next /oauth_auth.do redirects back with error=access_denied
    rejectRefresh: false, // refresh_token grants fail with invalid_grant
    disableCurrentUser: false, // /api/now/ui/user/current_user answers 404
    delays: {}, // pathname -> milliseconds to wait before answering
    counts: { total: 0, authorize: 0, token: 0, codeGrants: 0, refreshGrants: 0, api: 0, unauthorized: 0, writes: 0 },
    requests: [], // every API request: { method, path, query, accept, bearer, contentType }
    issued: { codes: [], accessTokens: [], refreshTokens: [], verifiers: [] },
    lastAuthorize: null,
    lastTokenRequest: null,
    pendingCodes: new Map(),
    accessTokens: new Map(), // token -> expiry time in ms
    refreshTokens: new Set(),
    user,
    tables: seedTables(user, other),
    columns: {}, // table -> Set of column names. Unknown columns are left out of reads and dropped from writes.
    rules: [], // business rules: (table, row) => void, run on every create and update before the row is stored
    attachments: new Map(), // sys_id -> { meta, bytes }
    revokeAccessTokens() { this.accessTokens.clear(); },
    // Change a record the way another user would, outside the API.
    touch(table, sysId, changes, by = other.user_name) {
      const row = this.tables[table].find((r) => r.sys_id === sysId);
      Object.assign(row, changes, { sys_mod_count: String(Number(row.sys_mod_count) + 1), sys_updated_on: tick(), sys_updated_by: by });
      return row;
    },
    allSecrets() { return [...this.issued.codes, ...this.issued.accessTokens, ...this.issued.refreshTokens, ...this.issued.verifiers]; },
    addAttachment(table, sysId, fileName, contentType, bytes) {
      const meta = {
        sys_id: hex32(), file_name: fileName, content_type: contentType, size_bytes: String(bytes.length),
        table_name: table, table_sys_id: sysId, sys_created_on: '2026-09-10 09:30:00', sys_created_by: user.user_name,
      };
      this.attachments.set(meta.sys_id, { meta, bytes });
      return meta;
    },
  };
  state.addAttachment('incident', state.tables.incident[0].sys_id, 'printer-log.txt', 'text/plain', Buffer.from('paper jam at 09:14\nrestart at 09:20\n'));
  for (const [table, rows] of Object.entries(state.tables)) {
    for (const row of rows) Object.assign(row, { sys_mod_count: '0', sys_updated_on: tick(), sys_updated_by: 'system' });
    state.columns[table] = new Set([...SYSTEM_COLUMNS, ...rows.flatMap((row) => Object.keys(row))]);
  }

  // Copy the columns a write may set, run the business rules, and stamp the row.
  function saveRow(table, row, body) {
    for (const [key, value] of Object.entries(body)) {
      if (state.columns[table].has(key) && !SYSTEM_COLUMNS.includes(key)) row[key] = value;
    }
    for (const rule of state.rules) rule(table, row);
    const now = tick();
    if (row.sys_mod_count === undefined) Object.assign(row, { sys_mod_count: '-1', sys_created_on: now, sys_created_by: user.user_name });
    Object.assign(row, { sys_mod_count: String(Number(row.sys_mod_count) + 1), sys_updated_on: now, sys_updated_by: user.user_name });
    return row;
  }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const snError = (res, status, message, detail = '') => json(res, status, { error: { message, detail }, status: 'failure' });
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  function issueTokens(refreshToken) {
    const access = secret();
    const refresh = refreshToken || secret();
    state.accessTokens.set(access, Date.now() + state.accessTokenTtlSeconds * 1000);
    state.refreshTokens.add(refresh);
    state.issued.accessTokens.push(access);
    if (!refreshToken) state.issued.refreshTokens.push(refresh);
    return { access_token: access, refresh_token: refresh, scope: 'useraccount', token_type: 'Bearer', expires_in: state.accessTokenTtlSeconds };
  }

  function authorize(url, res) {
    state.counts.authorize += 1;
    const q = url.searchParams;
    state.lastAuthorize = Object.fromEntries(q);
    const redirect = q.get('redirect_uri');
    if (q.get('response_type') !== 'code' || !redirect || !q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad authorization request');
      return;
    }
    const back = new URL(redirect);
    if (state.denyNextAuthorize) {
      state.denyNextAuthorize = false;
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', 'The user said no');
    } else {
      const code = secret();
      state.issued.codes.push(code);
      state.pendingCodes.set(code, { challenge: q.get('code_challenge'), redirect, clientId: q.get('client_id') });
      back.searchParams.set('code', code);
    }
    back.searchParams.set('state', q.get('state') || '');
    res.writeHead(302, { Location: back.toString() });
    res.end();
  }

  async function token(req, res) {
    state.counts.token += 1;
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    const grant = form.get('grant_type');
    state.lastTokenRequest = { grant, contentType: req.headers['content-type'] || '', hasSecret: form.has('client_secret') };
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
      return json(res, 400, { error: 'invalid_request', error_description: 'wrong content type' });
    }
    if (form.get('client_id') !== state.clientId) {
      return json(res, 401, { error: 'invalid_client', error_description: 'Unknown client id' });
    }
    if (grant === 'authorization_code') {
      state.counts.codeGrants += 1;
      const verifier = form.get('code_verifier') || '';
      if (verifier) state.issued.verifiers.push(verifier);
      const pending = state.pendingCodes.get(form.get('code'));
      state.pendingCodes.delete(form.get('code')); // codes work once
      if (!pending || pending.redirect !== form.get('redirect_uri')) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Unknown code or redirect' });
      }
      if (sha256url(verifier) !== pending.challenge) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE check failed' });
      }
      return json(res, 200, issueTokens());
    }
    if (grant === 'refresh_token') {
      state.counts.refreshGrants += 1;
      const refresh = form.get('refresh_token');
      if (state.rejectRefresh || !state.refreshTokens.has(refresh)) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token is not valid' });
      }
      return json(res, 200, issueTokens(refresh));
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  function shape(table, row, q) {
    const display = q.get('sysparm_display_value') || 'false';
    const plainRefs = q.get('sysparm_exclude_reference_link') === 'true';
    const fields = (q.get('sysparm_fields') || '').split(',').filter(Boolean);
    const out = {};
    for (const key of fields.length ? fields : Object.keys(row)) {
      // Like ServiceNow, a column the table does not have is left out.
      if (state.columns[table] && !state.columns[table].has(key)) continue;
      const value = row[key] ?? '';
      const refTable = (REFERENCES[table] || {})[key];
      const target = refTable ? state.tables[refTable].find((r) => r.sys_id === value) : null;
      const shown = target ? target.name : value;
      if (display === 'all') out[key] = { display_value: shown, value };
      else if (display === 'true') out[key] = shown;
      else if (refTable && value && !plainRefs) out[key] = { link: `/api/now/table/${refTable}/${value}`, value };
      else out[key] = value;
    }
    return out;
  }

  async function tableApi(req, res, url, table, sysId, raw) {
    const rows = state.tables[table];
    const q = url.searchParams;
    if (!rows) return snError(res, 400, `Invalid table ${table}`);
    const write = req.method !== 'GET';
    if (write) state.counts.writes += 1;
    if (write && table === 'sys_properties') {
      return snError(res, 403, 'Operation Failed', 'ACL Exception Update Failed due to security constraints');
    }
    if (!sysId && req.method === 'GET') {
      let found;
      try { found = runQuery(rows, q.get('sysparm_query'), state.user.user_name); } catch (err) { return snError(res, 400, err.message); }
      const offset = Number(q.get('sysparm_offset') || 0);
      const limit = Number(q.get('sysparm_limit') || 10000);
      const page = found.slice(offset, offset + limit).map((row) => shape(table, row, q));
      return json(res, 200, { result: page }, { 'X-Total-Count': String(found.length) });
    }
    if (!sysId && req.method === 'POST') {
      const row = saveRow(table, { sys_id: hex32() }, JSON.parse(raw.toString('utf8') || '{}'));
      rows.push(row);
      return json(res, 201, { result: shape(table, row, q) });
    }
    const index = rows.findIndex((row) => row.sys_id === sysId);
    if (index === -1) return snError(res, 404, 'No Record found', 'Record doesn\'t exist or ACL restricts the record retrieval');
    if (req.method === 'GET') return json(res, 200, { result: shape(table, rows[index], q) });
    if (req.method === 'PATCH' || req.method === 'PUT') {
      saveRow(table, rows[index], JSON.parse(raw.toString('utf8') || '{}'));
      return json(res, 200, { result: shape(table, rows[index], q) });
    }
    if (req.method === 'DELETE') {
      rows.splice(index, 1);
      res.writeHead(204);
      return res.end();
    }
    return snError(res, 405, 'Method not allowed');
  }

  async function attachmentApi(req, res, url, rest, raw) {
    const q = url.searchParams;
    if (req.method !== 'GET') state.counts.writes += 1;
    if (rest === '' && req.method === 'GET') {
      const all = runQuery([...state.attachments.values()].map((a) => a.meta), q.get('sysparm_query'), state.user.user_name);
      const page = all.slice(0, Number(q.get('sysparm_limit') || 10000));
      return json(res, 200, { result: page }, { 'X-Total-Count': String(all.length) });
    }
    if (rest === '/file' && req.method === 'POST') {
      const [table, sysId, fileName] = [q.get('table_name'), q.get('table_sys_id'), q.get('file_name')];
      if (!table || !sysId || !fileName) return snError(res, 400, 'Missing parameters', 'table_name, table_sys_id and file_name are required');
      const meta = state.addAttachment(table, sysId, fileName, req.headers['content-type'] || '', raw);
      return json(res, 201, { result: meta });
    }
    const m = /^\/([0-9a-f]{32})(\/file)?$/.exec(rest);
    const found = m ? state.attachments.get(m[1]) : null;
    if (!found) return snError(res, 404, 'No Record found', 'Attachment does not exist');
    if (req.method === 'GET' && m[2]) {
      res.writeHead(200, { 'Content-Type': found.meta.content_type, 'Content-Length': found.bytes.length });
      return res.end(found.bytes);
    }
    if (req.method === 'GET') return json(res, 200, { result: found.meta });
    if (req.method === 'DELETE') {
      state.attachments.delete(m[1]);
      res.writeHead(204);
      return res.end();
    }
    return snError(res, 405, 'Method not allowed');
  }

  async function api(req, res, url) {
    state.counts.api += 1;
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const raw = await readBody(req);
    const contentType = req.headers['content-type'] || '';
    let body; // JSON bodies are kept so the tests can see exactly what was sent
    if (contentType.startsWith('application/json') && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = undefined; }
    }
    state.requests.push({
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      accept: req.headers.accept || '', bearer: Boolean(bearer), contentType, body,
    });
    const expiry = state.accessTokens.get(bearer);
    if (!expiry || expiry <= Date.now()) {
      state.counts.unauthorized += 1;
      return snError(res, 401, 'User Not Authenticated', 'Required to provide Auth information');
    }
    const wait = state.delays[url.pathname];
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));

    if (url.pathname === '/api/now/ui/user/current_user') {
      if (state.disableCurrentUser) return snError(res, 404, 'Requested URI does not represent any resource');
      return json(res, 200, { result: { user_sys_id: user.sys_id, user_name: user.user_name, user_display_name: user.name, user_initials: 'AA' } });
    }
    let m = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (m) return tableApi(req, res, url, m[1], m[2], raw);
    m = /^\/api\/now\/attachment(.*)$/.exec(url.pathname);
    if (m) return attachmentApi(req, res, url, m[1], raw);
    return snError(res, 404, 'Requested URI does not represent any resource');
  }

  const server = http.createServer(async (req, res) => {
    state.counts.total += 1;
    try {
      const url = new URL(req.url, 'http://mock.invalid');
      if (url.pathname === '/oauth_auth.do' && req.method === 'GET') return authorize(url, res);
      if (url.pathname === '/oauth_token.do' && req.method === 'POST') return await token(req, res);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    } catch (err) {
      if (!res.headersSent) return snError(res, 500, 'Mock failure', String(err && err.message));
      return res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}
