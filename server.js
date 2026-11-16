'use strict';
// Live Q&A — zero dependencies. Node >= 16.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MOD_PASSWORD = process.env.MOD_PASSWORD || 'changeme';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DEFAULT_MAX_LEN = 300; // audience question length limit; the moderator can change it live (state.maxLen)
const MIN_MAX_LEN = 20;
const MAX_MAX_LEN = 1000;
const MAX_NAME = 40;
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 8000); // per-voter delay between questions
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- state ----------
let state = { premoderation: true, featuredId: null, questions: [], polls: [], livePollId: null, showResults: false, maxLen: DEFAULT_MAX_LEN };
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (raw && Array.isArray(raw.questions)) state = Object.assign(state, raw);
} catch (e) { /* first run */ }
if (!Number.isInteger(state.maxLen) || state.maxLen < MIN_MAX_LEN || state.maxLen > MAX_MAX_LEN) state.maxLen = DEFAULT_MAX_LEN;

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify(state), () => {});
  }, 500);
}

const lastSubmit = new Map(); // voterId -> ts

// ---------- live updates (SSE) ----------
const clients = new Set();
let pingTimer = null;
function broadcast() {
  if (pingTimer) return;
  pingTimer = setTimeout(() => {
    pingTimer = null;
    for (const res of clients) res.write('event: update\ndata: 1\n\n');
  }, 700); // coalesce bursts of votes
}
setInterval(() => { for (const res of clients) res.write(': keepalive\n\n'); }, 20000);

// ---------- helpers ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function isMod(req, url) {
  const key = req.headers['x-mod-key'] || url.searchParams.get('key') || '';
  return safeEq(key, MOD_PASSWORD);
}
// Normalises whitespace/control characters. Truncates only if `max` is given.
function clean(s, max) {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return max === undefined ? t : t.slice(0, max);
}
function pub(q, voterId) {
  return {
    id: q.id, text: q.text, name: q.name, ts: q.ts, answered: !!q.answered,
    votes: q.voters.length, voted: voterId ? q.voters.includes(voterId) : false,
  };
}
// ----- polls -----
// p.votes: { 'v_<voterId>': [optionIndex, ...] }
// forAudience=true: counts are withheld (null) until the moderator reveals the results.
function pubPoll(p, voterId, forAudience) {
  const counts = p.options.map(() => 0);
  let voters = 0;
  for (const arr of Object.values(p.votes)) { voters++; for (const i of arr) counts[i]++; }
  return {
    id: p.id, question: p.question, options: p.options, multi: p.multi, status: p.status,
    counts: forAudience && !state.showResults ? null : counts, voters, mine: (voterId && p.votes['v_' + voterId]) || [],
  };
}
function livePoll(voterId) {
  const p = state.polls.find((x) => x.id === state.livePollId);
  return p ? pubPoll(p, voterId, true) : null;
}

function modView(q) {
  return { id: q.id, text: q.text, name: q.name, ts: q.ts, status: q.status, answered: !!q.answered, votes: q.voters.length };
}

// ---------- routes ----------
const PAGES = { '/': 'index.html', '/mod': 'mod.html', '/screen': 'screen.html' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && PAGES[p]) {
    fs.readFile(path.join(PUBLIC_DIR, PAGES[p]), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // ----- audience -----
  if (p === '/api/questions' && req.method === 'GET') {
    const v = clean(url.searchParams.get('v'), 64);
    const list = state.questions.filter((q) => q.status === 'approved').map((q) => pub(q, v));
    return json(res, 200, { premoderation: state.premoderation, featuredId: state.featuredId, questions: list, poll: livePoll(v), maxLen: state.maxLen });
  }

  if (p === '/api/poll/vote' && req.method === 'POST') {
    const b = await readBody(req);
    const voterId = clean(b.voterId, 64);
    const poll = state.polls.find((x) => x.id === b.id && x.id === state.livePollId);
    if (!poll || !voterId) return json(res, 404, { error: 'not_found' });
    if (poll.status !== 'open') return json(res, 409, { error: 'closed' });
    let ch = Array.isArray(b.choices) ? b.choices.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < poll.options.length) : [];
    ch = Array.from(new Set(ch));
    if (!ch.length) return json(res, 400, { error: 'invalid' });
    if (!poll.multi) ch = ch.slice(0, 1);
    poll.votes['v_' + voterId] = ch;
    save(); broadcast();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/questions' && req.method === 'POST') {
    const b = await readBody(req);
    const voterId = clean(b.voterId, 64);
    const text = clean(b.text); // no truncation: a question that is too long is refused, not silently cut
    if (!voterId || text.length < 3) return json(res, 400, { error: 'invalid' });
    if (text.length > state.maxLen) return json(res, 400, { error: 'too_long', max: state.maxLen, length: text.length });
    const now = Date.now();
    if (now - (lastSubmit.get(voterId) || 0) < MIN_INTERVAL_MS) return json(res, 429, { error: 'too_fast' });
    lastSubmit.set(voterId, now);
    const q = {
      id: crypto.randomBytes(5).toString('hex'), text, name: clean(b.name, MAX_NAME), ts: now,
      status: state.premoderation ? 'pending' : 'approved', answered: false, voters: [],
    };
    state.questions.push(q);
    save(); broadcast();
    return json(res, 200, { ok: true, status: q.status });
  }

  if (p === '/api/vote' && req.method === 'POST') {
    const b = await readBody(req);
    const voterId = clean(b.voterId, 64);
    const q = state.questions.find((x) => x.id === b.id && x.status === 'approved');
    if (!q || !voterId) return json(res, 404, { error: 'not_found' });
    const i = q.voters.indexOf(voterId);
    if (b.on && i < 0) q.voters.push(voterId);
    if (!b.on && i >= 0) q.voters.splice(i, 1);
    save(); broadcast();
    return json(res, 200, { ok: true, votes: q.voters.length });
  }

  // ----- moderator -----
  if (p.startsWith('/api/mod/')) {
    if (!isMod(req, url)) return json(res, 401, { error: 'unauthorized' });

    if (p === '/api/mod/questions' && req.method === 'GET') {
      return json(res, 200, {
        premoderation: state.premoderation, featuredId: state.featuredId, connected: clients.size,
        questions: state.questions.map(modView),
        polls: state.polls.map((x) => pubPoll(x, null, false)), livePollId: state.livePollId, showResults: state.showResults,
        maxLen: state.maxLen, minMaxLen: MIN_MAX_LEN, maxMaxLen: MAX_MAX_LEN,
      });
    }
    if (p === '/api/mod/export-polls.csv' && req.method === 'GET') {
      const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      const rows = ['poll,option,votes,total_voters'];
      for (const x of state.polls) {
        const pp = pubPoll(x, null, false);
        pp.options.forEach((o, i) => rows.push([esc(pp.question), esc(o), pp.counts[i], pp.voters].join(',')));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="polls.csv"' });
      return res.end('﻿' + rows.join('\n'));
    }
    if (p === '/api/mod/export.csv' && req.method === 'GET') {
      const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      const rows = [['time', 'status', 'answered', 'votes', 'name', 'question'].join(',')];
      for (const q of state.questions) {
        rows.push([new Date(q.ts).toISOString(), q.status, q.answered, q.voters.length, esc(q.name), esc(q.text)].join(','));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="questions.csv"' });
      return res.end('﻿' + rows.join('\n'));
    }

    const b = req.method === 'POST' ? await readBody(req) : {};
    if (p === '/api/mod/set' && req.method === 'POST') {
      const q = state.questions.find((x) => x.id === b.id);
      if (!q) return json(res, 404, { error: 'not_found' });
      if (['pending', 'approved', 'rejected'].includes(b.status)) {
        q.status = b.status;
        if (b.status !== 'approved' && state.featuredId === q.id) state.featuredId = null;
      }
      if (typeof b.answered === 'boolean') {
        q.answered = b.answered;
        if (b.answered && state.featuredId === q.id) state.featuredId = null;
      }
      save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/mod/feature' && req.method === 'POST') {
      state.featuredId = b.id || null;
      save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/mod/settings' && req.method === 'POST') {
      if (typeof b.premoderation === 'boolean') state.premoderation = b.premoderation;
      if (b.maxLen !== undefined) {
        const n = Number(b.maxLen);
        if (!Number.isInteger(n) || n < MIN_MAX_LEN || n > MAX_MAX_LEN) return json(res, 400, { error: 'invalid_max_len', min: MIN_MAX_LEN, max: MAX_MAX_LEN });
        state.maxLen = n; // questions already posted are left untouched
      }
      save(); broadcast();
      return json(res, 200, { ok: true, maxLen: state.maxLen });
    }
    if (p === '/api/mod/poll/create' && req.method === 'POST') {
      const question = clean(b.question, 200);
      const options = (Array.isArray(b.options) ? b.options : []).map((o) => clean(o, 100)).filter(Boolean).slice(0, 8);
      if (question.length < 3 || options.length < 2) return json(res, 400, { error: 'invalid' });
      state.polls.push({ id: crypto.randomBytes(5).toString('hex'), question, options, multi: !!b.multi, status: 'draft', votes: {} });
      save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/mod/poll/') && req.method === 'POST') {
      const action = p.slice('/api/mod/poll/'.length);
      const poll = state.polls.find((x) => x.id === b.id);
      if (action === 'hide') {
        const live = state.polls.find((x) => x.id === state.livePollId);
        if (live && live.status === 'open') live.status = 'closed';
        state.livePollId = null; state.showResults = false;
      } else if (action === 'results') {
        state.showResults = !!b.show;
      } else if (!poll) {
        return json(res, 404, { error: 'not_found' });
      } else if (action === 'launch') {
        for (const x of state.polls) if (x.status === 'open' && x.id !== poll.id) x.status = 'closed';
        poll.status = 'open'; state.livePollId = poll.id; state.showResults = false;
      } else if (action === 'reopen') {
        if (poll.id === state.livePollId) poll.status = 'open';
      } else if (action === 'close') {
        poll.status = 'closed';
      } else if (action === 'delete') {
        state.polls = state.polls.filter((x) => x.id !== poll.id);
        if (state.livePollId === poll.id) state.livePollId = null;
      } else {
        return json(res, 404, { error: 'not_found' });
      }
      save(); broadcast();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/mod/add' && req.method === 'POST') {
      const text = clean(b.text, MAX_MAX_LEN); // the moderator is not bound by the audience limit
      if (text.length < 3) return json(res, 400, { error: 'invalid' });
      state.questions.push({
        id: crypto.randomBytes(5).toString('hex'), text, name: clean(b.name, MAX_NAME), ts: Date.now(),
        status: 'approved', answered: false, voters: [],
      });
      save(); broadcast();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  }

  res.writeHead(404); res.end('not found');
}

http.createServer((req, res) => {
  handle(req, res).catch(() => { if (!res.headersSent) json(res, 400, { error: 'bad_request' }); else res.end(); });
}).listen(PORT, () => {
  console.log(`Q&A running on port ${PORT}`);
  if (MOD_PASSWORD === 'changeme') console.log('WARNING: set MOD_PASSWORD (default "changeme" is in use)');
});
