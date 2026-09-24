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
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
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

async function cv(env, path, params, ttl) {
  const p = new URLSearchParams(params);
  return cached(env, `cv:${path}?${p}`, ttl, async () => {
    p.set('format', 'json');
    p.set('api_key', clean(env.CV_KEY));
    const d = await getJson(`${CV}${path}?${p}`);
    if (d.status_code !== 1) throw new Error(`Comic Vine: ${d.error}`);
    return { results: d.results, total: d.number_of_total_results, offset: d.offset, limit: d.limit };
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

function olToBook(w) {
  const e = (w.editions && w.editions.docs && w.editions.docs[0]) || {};
  const isbns = e.isbn || [];
  const isbn = isbns.find((i) => i.length === 13) || isbns[0] || '';
  const cover = e.cover_i || w.cover_i;
  return {
    source: 'openlibrary', olid: e.key || w.key, isbn,
    title: [e.title || w.title, e.subtitle || w.subtitle].filter(Boolean).join(': '),
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
