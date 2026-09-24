// ComicSelves API: proxies Comic Vine / Google Books / Open Library and stores the collection in D1.
// Every /api route needs "Authorization: Bearer <APP_TOKEN>".

const CV = 'https://comicvine.gamespot.com/api';
const UA = 'ComicSelves/1.0 (personal collection app)';
const DAY = 86400;

// Comic Vine resource type -> id prefix used in detail URLs
const CV_TYPES = { volume: '4050', issue: '4000', person: '4040', story_arc: '4045' };

const CV_FIELDS = {
  search: 'id,name,resource_type,start_year,publisher,image,count_of_issues,issue_number,volume,cover_date,deck',
  volume: 'id,name,start_year,publisher,image,count_of_issues,deck,description,site_detail_url,people',
  issue: 'id,name,issue_number,volume,cover_date,store_date,image,deck,description,person_credits,story_arc_credits,site_detail_url',
  person: 'id,name,image,deck,description,site_detail_url,volume_credits,story_arc_credits',
  story_arc: 'id,name,image,deck,description,publisher,issues,site_detail_url',
  issues: 'id,name,issue_number,cover_date,image,volume',
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    if (parts[0] !== 'api') return json({ ok: true, app: 'comicselves' });

    const auth = req.headers.get('Authorization') || '';
    const appToken = clean(env.APP_TOKEN);
    if (!appToken || auth !== `Bearer ${appToken}`) return json({ error: 'unauthorized' }, 401);

    try {
      return await route(parts.slice(1), url, req, env);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};

async function route([area, a, b], url, req, env) {
  const q = url.searchParams;

  if (area === 'ping') return json({ ok: true });

  // ---- Comic Vine ----
  if (area === 'cv') {
    if (a === 'search') {
      const type = CV_TYPES[q.get('type')] ? q.get('type') : 'volume';
      return json(await cv(env, '/search/', {
        query: q.get('q') || '', resources: type, limit: '20', page: q.get('page') || '1', field_list: CV_FIELDS.search,
      }, DAY));
    }
    if (a === 'issues') {
      // all issues of a volume, oldest first (max 100 per page)
      return json(await cv(env, '/issues/', {
        filter: `volume:${int(q.get('volume'))}`, sort: 'cover_date:asc', limit: '100',
        offset: String(int(q.get('offset') || '0')), field_list: CV_FIELDS.issues,
      }, DAY));
    }
    if (a === 'issues-by-id') {
      // batch lookup, e.g. ids=1|2|3 (used for story arcs)
      const ids = (q.get('ids') || '').split('|').map(int).filter(Boolean).slice(0, 100);
      return json(await cv(env, '/issues/', {
        filter: `id:${ids.join('|')}`, limit: '100', field_list: CV_FIELDS.issues,
      }, 7 * DAY));
    }
    if (a === 'collects') return json(await collects(env, int(q.get('volume'))));
    // the app calls Comic Vine's /issues list directly from the browser (see NOTE in volIssueList)
    if (a === 'key') return json({ key: clean(env.CV_KEY) });
    if (a === 'parse' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return json(await parsePasted(env, body.text, int(body.year)));
    }
    if (CV_TYPES[a]) {
      return json(await cv(env, `/${a}/${CV_TYPES[a]}-${int(b)}/`, { field_list: CV_FIELDS[a] }, 7 * DAY));
    }
  }

  // ---- Books (ISBN / Spanish editions) ----
  if (area === 'isbn') return json(await isbnLookup(env, String(a || '').replace(/[^0-9Xx]/g, '')));
  if (area === 'books' && a === 'search') {
    // Open Library search: one result per work, using the best-matching edition (Spanish preferred)
    const params = new URLSearchParams({ q: q.get('q') || '', limit: '20', page: String(int(q.get('page')) || 1), lang: 'es', fields: OL_FIELDS });
    const data = await cached(env, `ol:${params}`, DAY, () => getJson(`https://openlibrary.org/search.json?${params}`));
    return json({ results: (data.docs || []).map(olToBook), total: data.numFound || 0 });
  }

  // ---- Collection ----
  if (area === 'items') {
    if (req.method === 'GET' && !a) {
      const { results } = await env.DB.prepare('SELECT * FROM items ORDER BY updated_at DESC').all();
      return json({ items: results.map(rowToItem) });
    }
    const id = decodeURIComponent(a || '');
    if (!id) return json({ error: 'missing id' }, 400);
    if (req.method === 'PUT') {
      const it = await req.json();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO items (id, kind, title, data, owned, read, pending, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET kind=?2, title=?3, data=?4, owned=?5, read=?6, pending=?7, updated_at=?8`
      ).bind(id, it.kind || 'book', it.title || '(sin título)', JSON.stringify(it.data || {}),
        it.owned ? 1 : 0, it.read ? 1 : 0, it.pending ? 1 : 0, now).run();
      return json({ ok: true, updated_at: now });
    }
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM items WHERE id = ?1').bind(id).run();
      return json({ ok: true });
    }
  }

  return json({ error: 'not found' }, 404);
}

// ---------- helpers ----------

const int = (v) => Math.max(0, parseInt(v, 10) || 0);
// secrets piped in from a Windows shell can carry a BOM or trailing CRLF
const clean = (s) => String(s || '').replace(/^﻿/, '').trim();

function rowToItem(r) {
  return { id: r.id, kind: r.kind, title: r.title, data: JSON.parse(r.data || '{}'),
    owned: !!r.owned, read: !!r.read, pending: !!r.pending, created_at: r.created_at, updated_at: r.updated_at };
}

async function getJson(u, headers = {}) {
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`${new URL(u).host} respondió ${r.status}`);
  return r.json();
}

// Cache keyed by the request (never includes secrets) in D1.
async function cached(env, key, ttl, load) {
  const now = Math.floor(Date.now() / 1000);
  const hit = await env.DB.prepare('SELECT v FROM cache WHERE k = ?1 AND exp > ?2').bind(key, now).first();
  if (hit) return JSON.parse(hit.v);
  const data = await load();
  await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?1, ?2, ?3)')
    .bind(key, JSON.stringify(data), now + ttl).run();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM cache WHERE exp <= ?1').bind(now).run();
  return data;
}

// Comic Vine blocks bursts ("velocity detection", HTTP 420): space live calls out and retry once.
const CV_GAP_MS = 1100;
let cvNext = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cvThrottle() {
  const wait = cvNext - Date.now();
  cvNext = Math.max(Date.now(), cvNext) + CV_GAP_MS;
  if (wait > 0) await sleep(wait);
}

async function cv(env, path, params, ttl) {
  const p = new URLSearchParams(params);
  return cached(env, `cv:${path}?${p}`, ttl, async () => {
    p.set('format', 'json');
    p.set('api_key', clean(env.CV_KEY));
    for (let attempt = 0; ; attempt++) {
      await cvThrottle();
      const r = await fetch(`${CV}${path}?${p}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if ((r.status === 420 || r.status === 429) && attempt === 0) { await sleep(4000); continue; }
      if (r.status === 420 || r.status === 429) {
        const body = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        console.log('Comic Vine', r.status, path, body);
        throw new Error(`Comic Vine está limitando las consultas (${r.status}${body ? `: ${body}` : ''}). Espera un par de minutos y vuelve a intentarlo.`);
      }
      if (!r.ok) throw new Error(`Comic Vine respondió ${r.status}`);
      const d = await r.json();
      if (d.status_code !== 1) throw new Error(`Comic Vine: ${d.error}`);
      return { results: d.results, total: d.number_of_total_results, offset: d.offset, limit: d.limit };
    }
  });
}

function gbToBook(it) {
  const v = it.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn = (ids.find((i) => i.type === 'ISBN_13') || ids.find((i) => i.type === 'ISBN_10') || {}).identifier || '';
  const img = v.imageLinks || {};
  return {
    source: 'google', gid: it.id, isbn,
    title: [v.title, v.subtitle].filter(Boolean).join(': '),
    authors: v.authors || [], publisher: v.publisher || '', date: v.publishedDate || '',
    pages: v.pageCount || null, language: v.language || '', description: v.description || '',
    cover: (img.thumbnail || img.smallThumbnail || '').replace(/^http:/, 'https:').replace('&edge=curl', ''),
  };
}

const OL_FIELDS = 'key,title,subtitle,author_name,cover_i,first_publish_year,editions,editions.key,editions.title,editions.subtitle,'
  + 'editions.publisher,editions.isbn,editions.publish_date,editions.cover_i,editions.language,editions.number_of_pages_median';

// "Daredevil: Born Again" + "Born Again" -> no repeated subtitle
const joinTitle = (t, sub) => (sub && !String(t || '').toLowerCase().includes(sub.toLowerCase()) ? `${t}: ${sub}` : t || '');

function olToBook(w) {
  const e = (w.editions && w.editions.docs && w.editions.docs[0]) || {};
  const isbns = e.isbn || [];
  const isbn = isbns.find((i) => i.length === 13) || isbns[0] || '';
  const cover = e.cover_i || w.cover_i;
  return {
    source: 'openlibrary', olid: e.key || w.key, isbn,
    title: joinTitle(e.title || w.title, e.subtitle || w.subtitle),
    authors: (w.author_name || []).map((n) => n.replace(/\s*\(Duplicate of .*?\)/, '')),
    publisher: (e.publisher || []).filter(Boolean).join(', '),
    date: (e.publish_date || [])[0] || (w.first_publish_year ? String(w.first_publish_year) : ''),
    pages: null, language: (e.language || [])[0] || '', description: '',
    cover: cover ? `https://covers.openlibrary.org/b/id/${cover}-M.jpg` : '',
  };
}

async function isbnLookup(env, isbn) {
  if (!/^(\d{9}[\dXx]|\d{13})$/.test(isbn)) return { found: false, isbn, error: 'ISBN no válido' };
  // Google Books' anonymous quota is shared and usually exhausted: only used with a GB_KEY secret.
  const gbKey = clean(env.GB_KEY);
  const [gb, ol, ols] = await Promise.all([
    gbKey ? cached(env, `gbisbn:${isbn}`, 7 * DAY, () => getJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&key=${gbKey}`)).catch(() => ({})) : {},
    cached(env, `olisbn:${isbn}`, 7 * DAY, () => getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`)).catch(() => ({})),
    // the search index knows ISBNs the books API sometimes misses
    cached(env, `olsisbn:${isbn}`, 7 * DAY, () => getJson(`https://openlibrary.org/search.json?${new URLSearchParams({ isbn, limit: '1', fields: OL_FIELDS })}`)).catch(() => ({})),
  ]);
  const g = gb.items && gb.items[0] ? gbToBook(gb.items[0]) : null;
  const s = ols.docs && ols.docs[0] ? olToBook(ols.docs[0]) : null;
  const o = ol[`ISBN:${isbn}`];
  if (!g && !o && !s) return { found: false, isbn };
  const book = g || s || { source: 'openlibrary', isbn, title: '', authors: [], publisher: '', date: '', pages: null, description: '', cover: '' };
  book.isbn = isbn;
  book.isbn = book.isbn || isbn;
  if (o) {
    book.title = book.title || [o.title, o.subtitle].filter(Boolean).join(': ');
    if (!book.authors.length) book.authors = (o.authors || []).map((a) => a.name);
    book.publisher = book.publisher || (o.publishers || []).map((p) => p.name).join(', ');
    book.date = book.date || o.publish_date || '';
    book.pages = book.pages || o.number_of_pages || null;
    book.cover = book.cover || (o.cover && (o.cover.large || o.cover.medium)) || '';
  }
  return { found: true, isbn, book };
}

// ---------- "Collects: Batman #404-407" -> original Comic Vine issues ----------

const htmlText = (h) => String(h || '')
  .replace(/<\/(p|h\d|li|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+/g, ' ');

// Series names are runs of Capitalized Words (with small connectors), right before the numbers.
// A trailing 'YY is part of the name: "R.E.B.E.L.S. '94".
const SERIES = String.raw`[A-Z][\w'’.:\/-]*(?:\s+(?:(?:of|the|and|in|vs\.?|de|del|la|el|los)\s+)*(?:[A-Z][\w'’.:\/-]*|['’]\d{2}\b))*`;
// groups: 1 series, 2 "(...)" e.g. (2005), 3 year in the name ("Secret Files 2005 #1"), 4 from, 5 to
const PIECE = new RegExp(String.raw`(${SERIES})?\s*(?:\(([^)]*)\)\s*)?(?:((?:19|20)\d{2})\s+(?=#))?(?:Vol(?:ume)?\.?\s*\d+\s*)?(?:#\s*|\b)(\d{1,4}(?:\.\d)?)(?:\s*(?:-|–|to|through)\s*#?\s*(\d{1,4}(?:\.\d)?))?`);
const JUNK = /^(?:Collects|Collecting|Collected|Issues?|Includes|Including|Featuring|Plus|Material|Stories|From|Originally|And|The|This|Volume|Vol\.?|Book|Part|Chapter|TPB|HC|Recopila|Contiene|Incluye|Los|Las|El|La|USA|Números?|Nº)$/i;

// loose: the text IS the list (pasted by the user), no "Collects" keyword needed
function parseCollects(text, loose = false) {
  const lists = [];
  // the list ends at a full stop, but not the one of an abbreviation like "R.E.B.E.L.S."
  const re = /(?:collect(?:s|ing|ed)?|recopila(?:n|ndo)?|contiene|incluye)\b([\s\S]{0,1500}?)(?:(?<![A-Z])[.!](?:\s|$)|\n|$)/gi;
  let m;
  while ((m = re.exec(text))) lists.push(m[1]);
  if (loose && !lists.length) lists.push(text);
  const out = [];
  for (const list of lists) {
    let series = '', year = '', nameYear = '';
    for (const piece of list.split(/,|;|\n|\band\b|&|\bplus\b/i)) {
      const p = PIECE.exec(piece);
      if (!p) continue;
      let name = (p[1] || '').trim().replace(/[:.]+$/, '');
      // drop leading filler words ("Collects", "The" ...)
      const words = name.split(/\s+/).filter(Boolean);
      while (words.length && JUNK.test(words[0])) words.shift();
      name = words.join(' ').replace(/\s+(?:USA|US)$/, ''); // Spanish editions: "Batman USA #404"
      let y = ((p[2] || '').match(/\b(19|20)\d{2}\b/) || [])[0] || '';
      // "R.E.B.E.L.S. '94" -> series "R.E.B.E.L.S.", year 1994
      const yy = name.match(/\s+['’](\d{2})$/);
      if (yy) { name = name.slice(0, yy.index); y = y || `${+yy[1] > 30 ? 19 : 20}${yy[1]}`; }
      // numbers without a name ("#124-125") belong to the previous series, but only if the piece starts with them;
      // otherwise the name wasn't understood and guessing would add wrong issues
      if (!name && !/^\s*(?:\([^)]*\)\s*)?#?\s*\d/.test(piece)) continue;
      if (name) { series = name; year = y; nameYear = p[3] || ''; } else if (y) year = y;
      const from = parseFloat(p[4]);
      const to = p[5] ? parseFloat(p[5]) : from;
      if (!series || isNaN(from) || to < from || to - from > 200) continue;
      if (from >= 1900 && from <= 2099 && !p[5]) continue; // a lone year, not an issue
      out.push({ series, year, nameYear, from, to });
    }
  }
  const seen = new Set();
  return out.filter((g) => { const k = `${g.series}|${g.year}|${g.nameYear}|${g.from}|${g.to}`; return !seen.has(k) && seen.add(k); });
}

function mergeRanges(rs) {
  const s = rs.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Original-language publishers: preferred over foreign reprint series with the same name.
const US_PUBLISHERS = new Set(['DC Comics', 'Marvel', 'Image', 'Dark Horse Comics', 'IDW Publishing', 'Vertigo', 'BOOM! Studios',
  'Dynamite Entertainment', 'Valiant', 'WildStorm', 'Top Cow', 'Oni Press', 'Archie Publications', 'Fantagraphics', 'Skybound']);

// Comic Vine volumes that could be "<series>" #1-<maxNum>
async function candidates(env, e, maxNum, ctxYear, publisher) {
  // "Green Lantern: Sinestro Corps Special" is filed as "Sinestro Corps Special": also try the part after ':'
  const names = [...(e.nameYear ? [`${e.series} ${e.nameYear}`] : []), e.series,
    ...e.series.split(':').slice(1).map((s) => s.trim()).filter(Boolean)];
  const narrow = (c, name) => {
    const pick = (f) => { const r = c.filter(f); if (r.length) c = r; };
    if (publisher) pick((v) => v.publisher?.name === publisher);
    else pick((v) => US_PUBLISHERS.has(v.publisher?.name));
    if (e.year) pick((v) => String(v.start_year) === e.year);
    pick((v) => (v.count_of_issues || 0) >= maxNum);
    if (ctxYear) pick((v) => !v.start_year || +v.start_year <= ctxYear);
    return c.sort((a, b) => (+b.start_year || 0) - (+a.start_year || 0));
  };
  let firstResults = null;
  for (const name of names) {
    const d = await cv(env, '/search/', { query: name, resources: 'volume', limit: '50', field_list: 'id,name,start_year,count_of_issues,publisher' }, 7 * DAY);
    firstResults = firstResults || d.results || [];
    let c = (d.results || []).filter((v) => norm(v.name) === norm(name));
    // "Secret Files 2005": the year must match, not just the name
    if (e.nameYear && !name.includes(e.nameYear)) c = c.filter((v) => String(v.start_year) === e.nameYear);
    if (c.length) return narrow(c, name);
  }
  // loose pass: every word of the name present, at most 2 extra words
  // ("Green Lantern Secret Files 2005" -> "Green Lantern Secret Files and Origins 2005")
  const want = norm(names[0]).split(' ');
  const c = (firstResults || []).filter((v) => {
    const have = norm(v.name).split(' ');
    return want.every((w) => have.includes(w)) && have.length - want.length <= 2;
  });
  return c.length ? narrow(c, names[0]) : [];
}

// Among several runs with the same name, choose one:
// 1) the one closest in time to the series that are unambiguous in the same list (anchor year);
// 2) else the most recent run whose issue #maxNum already existed when the collection came out;
// 3) else the longest run.
async function chooseRun(env, c, maxNum, ctxYear, anchor) {
  if (c.length <= 1) return c[0] || null;
  if (anchor) {
    const score = (v) => Math.abs((+v.start_year || 0) - anchor) + (+v.start_year > anchor ? 0.5 : 0);
    return c.slice().sort((a, b) => score(a) - score(b))[0];
  }
  if (ctxYear) {
    for (const v of c.slice(0, 5)) {
      const it = (await volIssueList(env, v.id)).issues.find((i) => parseFloat(i.issue_number) === maxNum);
      if (!it) continue;
      const r = await cv(env, `/issue/4000-${it.id}/`, { field_list: 'id,cover_date' }, 7 * DAY);
      const y = +(r.results?.cover_date || '').slice(0, 4);
      if (y && y <= ctxYear) return v;
    }
  }
  return c.slice().sort((a, b) => (b.count_of_issues || 0) - (a.count_of_issues || 0))[0];
}

async function resolveGroups(env, groups, ctxYear, publisher) {
  const bySeries = new Map();
  for (const g of groups) {
    const k = `${norm(g.series)}|${g.year}|${g.nameYear || ''}`;
    const e = bySeries.get(k) || { series: g.series, year: g.year, nameYear: g.nameYear || '', ranges: [] };
    e.ranges.push([g.from, g.to]);
    bySeries.set(k, e);
  }
  // "Green Lantern: Sinestro Corps Special" and "Sinestro Corps Special" are the same book
  const keys = [...bySeries.keys()];
  for (const k of keys) {
    const [n] = k.split('|');
    if (keys.some((o) => o !== k && bySeries.has(o) && n.endsWith(' ' + o.split('|')[0]))) bySeries.delete(k);
  }
  const entries = [...bySeries.values()];
  for (const e of entries) {
    e.ranges = mergeRanges(e.ranges);
    e.maxNum = Math.max(...e.ranges.map((r) => r[1]));
    e.cands = await candidates(env, e, e.maxNum, ctxYear, publisher); // errors (rate limit) must reach the user
  }
  const years = entries.filter((e) => e.cands.length === 1 && e.cands[0].start_year).map((e) => +e.cands[0].start_year).sort((a, b) => a - b);
  const anchor = years.length ? years[Math.floor(years.length / 2)] : 0;

  const result = [];
  const volIds = new Set();
  for (const e of entries) {
    const found = await chooseRun(env, e.cands, e.maxNum, ctxYear, anchor);
    if (found && volIds.has(found.id)) continue;
    if (found) volIds.add(found.id);
    const issues = found ? await issuesInRanges(env, found.id, e.ranges) : [];
    result.push({
      series: e.series, ranges: e.ranges, issues,
      volume: found ? { id: found.id, name: found.name, start_year: found.start_year, publisher: found.publisher?.name || '' } : null,
    });
  }
  return result;
}

// NOTE: the /issues list endpoint is often blocked ("Slow down cowboy", HTTP 420) for Cloudflare's shared
// IPs even when our own quota is fine. The Worker therefore never uses it: it relies on the volume's issue
// list (/volume) and single issues (/issue). Covers and dates for lists are fetched by the browser (JSONP).
async function volIssueList(env, volId) {
  const v = await cv(env, `/volume/4050-${volId}/`, { field_list: 'id,name,issues' }, DAY);
  return { id: v.results?.id, name: v.results?.name, issues: v.results?.issues || [] };
}

// Issues of a volume within number ranges: id, number and title (no cover/date, see NOTE above).
async function issuesInRanges(env, volId, ranges) {
  const v = await volIssueList(env, volId);
  return v.issues.filter((i) => {
    const n = parseFloat(i.issue_number);
    // 23.1-23.4 style specials only when explicitly listed
    return ranges.some(([a, b]) => n >= a && n <= b && (Number.isInteger(n) || n === a || n === b));
  }).map((i) => ({ id: i.id, name: i.name || '', issue_number: i.issue_number, volume: { id: v.id, name: v.name } }))
    .sort((a, b) => parseFloat(a.issue_number) - parseFloat(b.issue_number));
}

async function collects(env, volId) {
  if (!volId) return { error: 'missing volume' };
  const vol = await cv(env, `/volume/4050-${volId}/`, { field_list: 'id,name,start_year,description,deck,publisher,issues' }, 7 * DAY);
  const v = vol.results || {};
  // a collected edition is filed as a volume with 1-3 issues: their descriptions say what they collect
  const iss = [];
  for (const i of (v.issues || []).slice(0, 3)) {
    iss.push((await cv(env, `/issue/4000-${i.id}/`, { field_list: 'id,description,deck,cover_date' }, 7 * DAY)).results || {});
  }
  const text = [v.description, v.deck, ...iss.flatMap((i) => [i.description, i.deck])].map(htmlText).filter(Boolean).join('\n');
  const groups = parseCollects(text);
  const ctxYear = +v.start_year || +(iss[0]?.cover_date || '').slice(0, 4) || 0;
  const snippet = (text.match(/[^\n]{0,60}(?:collect|recopila|contiene|incluye)[^\n]{0,260}/i) || [''])[0].trim();
  // a Spanish edition (ECC...) reprints US books: only trust the publisher when it's an original one
  const pub = US_PUBLISHERS.has(v.publisher?.name) ? v.publisher.name : null;
  const result = await resolveGroups(env, groups, ctxYear, pub);
  return { volume: { id: v.id, name: v.name, start_year: v.start_year }, snippet, groups: result };
}

// Text pasted by the user, e.g. "Collects Green Lantern #1-17, Ion #1-12 and ..."
async function parsePasted(env, text, ctxYear) {
  const groups = parseCollects(String(text || '').slice(0, 5000), true);
  if (!groups.length) return { groups: [], error: 'No he encontrado ninguna serie con números (p. ej. "Batman #404-407").' };
  return { groups: await resolveGroups(env, groups, ctxYear, null) };
}
