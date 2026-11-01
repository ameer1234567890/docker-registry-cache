(() => {
  'use strict';

  const THEME_KEY = 'registry-cache-theme';
  const TOKEN_KEY = 'registry-cache-token';
  const POLL_MS = 30000;
  const MAX_SEGMENTS = 16;

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    data: null,
    error: null,
    reg: 'all',
    q: '',
    sort: { key: 'size', dir: 'desc' },
    open: new Set(),
  };

  /* ------------------------------------------------------------- theme */
  const root = document.documentElement;

  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage blocked */ }
    }
    const next = theme === 'dark' ? 'light' : 'dark';
    const btn = $('#theme');
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
    $('#theme-color').content = theme === 'dark' ? '#0d1319' : '#eef1f4';
  }

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  /* ----------------------------------------------------------- helpers */
  function fmtParts(n) {
    const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
    if (!n) return { v: '0', u: 'B' };
    const i = Math.min(Math.floor(Math.log10(n) / 3), units.length - 1);
    const v = n / Math.pow(1000, i);
    const text = i === 0 || v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return { v: text, u: units[i] };
  }
  const fmtBytes = (n) => { const p = fmtParts(n); return `${p.v} ${p.u}`; };
  const plural = (n, word) => {
    const many = word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`;
    return `${n.toLocaleString()} ${n === 1 ? word : many}`;
  };

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 45) return `${Math.round(s / 86400)} d ago`;
    return new Date(ts * 1000).toLocaleDateString();
  }
  const absTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
  const absDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : '');
  const builtAgo = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? '' : ago(t / 1000); };
  const colorOf = (i) => `var(--c${(i % 6) + 1})`;
  const shortDigest = (d) => String(d || '').replace('sha256:', '').slice(0, 12);

  const isHub = (reg) => /docker\.io$/.test(reg.endpoint || '');

  // The command people already type: clients use the upstream's own name, DNS sends it to the cache.
  function pullRef(reg, repo, tag) {
    if (!reg.endpoint) return '';
    if (isHub(reg)) return `docker pull ${repo.replace(/^library\//, '')}:${tag}`;
    return `docker pull ${reg.endpoint}/${repo}:${tag}`;
  }

  const svg = (d, size = 15) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON_CHEVRON = svg('<path d="M9 6l6 6-6 6"/>', 14);
  const ICON_COPY = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>');
  const ICON_TRASH = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>');
  const ICON_WARN = svg('<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.01"/>', 22);

  /* ------------------------------------------------------- derived data */
  const registries = () => (state.data ? state.data.registries : []);
  const canDelete = () => !!(state.data && state.data.capabilities && state.data.capabilities.delete);
  const tracking = () => (state.data && state.data.tracking) || { enabled: false };
  const clientName = (ip) => (state.data && state.data.clients && state.data.clients[ip]) || null;
  const hostLabel = (h) => h.name || h.ip;
  const inScope = () => registries().filter((r) => state.reg === 'all' || r.id === state.reg);

  function allRows() {
    const rows = [];
    registries().forEach((reg, ri) => {
      if (state.reg !== 'all' && reg.id !== state.reg) return;
      reg.repos.forEach((repo) => rows.push({ reg, ri, repo, key: `${reg.id}/${repo.name}` }));
    });
    return rows;
  }

  function filteredRows() {
    const q = state.q.trim().toLowerCase();
    let rows = allRows();
    if (q) {
      rows = rows.filter((r) => r.repo.name.toLowerCase().includes(q)
        || r.repo.tags.some((t) => t.name.toLowerCase().includes(q)));
    }
    const val = {
      name: (r) => r.repo.name.toLowerCase(),
      tags: (r) => r.repo.tags.length,
      size: (r) => r.repo.size,
      updated: (r) => r.repo.updated || 0,
    }[state.sort.key];
    const m = state.sort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      return ((x < y ? -1 : x > y ? 1 : 0) * m) || a.repo.name.localeCompare(b.repo.name);
    });
    return rows;
  }

  function platformsOf(repo) {
    const set = new Set();
    repo.tags.forEach((t) => t.platforms.forEach((p) => { if (p.cached) set.add(p.platform); }));
    return [...set].sort();
  }

  function findTag(regId, repoName, tagName) {
    const reg = registries().find((r) => r.id === regId);
    const repo = reg && reg.repos.find((r) => r.name === repoName);
    const tag = repo && repo.tags.find((t) => t.name === tagName);
    return { reg, repo, tag };
  }

  /* -------------------------------------------- why something is missing */
  const REASON_SHORT = {
    not_requested: 'never requested',
    failed: 'upstream fetch failed',
    evicted: 'expired or removed',
    foreign: 'cannot be cached',
    in_progress: 'downloading now',
  };

  function statusText(code) {
    if (code === 429) return 'the upstream registry rate-limited the request (HTTP 429); logging in to it raises the limit';
    if (code === 401 || code === 403) return `the upstream registry refused access (HTTP ${code}); add credentials for this registry`;
    if (code === 404) return 'the upstream registry does not have it (HTTP 404)';
    if (code === 499) return 'the client closed the connection mid-download (HTTP 499)';
    if (code >= 500) return `the upstream registry was unreachable or failing (HTTP ${code})`;
    return `HTTP ${code}`;
  }

  function hostName(ip) {
    const n = clientName(ip);
    return n ? `${n} (${ip})` : ip;
  }

  function keepFor() {
    const ttl = state.data && state.data.ttl;
    return ttl && ttl !== '0' ? `the cache keeps items for ${ttl}, or it was deleted from disk` : 'it was deleted from disk';
  }

  function reasonText(r) {
    switch (r.code) {
      case 'foreign':
        return 'A non-distributable layer. Clients fetch it from its own source, so it can never be cached.';
      case 'failed':
        return `The last attempt to fetch it failed: ${statusText(r.status)}${r.ip ? `, requested by ${hostName(r.ip)}` : ''}, ${ago(r.t)}.`;
      case 'evicted':
        return `It was cached on ${absDate(r.t)} and has since been removed: ${keepFor()}.`;
      case 'in_progress':
        return 'A download into this repository is running right now.';
      default:
        return 'No client has requested this layer through the cache. A client skips layers it already has locally, or its pull stopped before reaching this one.';
    }
  }

  // A platform that no client has pulled is the normal state of a pull-through cache, so it is not shown.
  // Platforms missing for a real reason (a failed fetch, expiry) still are.
  const isIdle = (p) => !p.cached && (p.missing || []).every((m) => m.reason.code === 'not_requested');

  function gapSummary(p) {
    const miss = p.missing || [];
    if (!p.cached) return reasonText(miss[0].reason);
    const layers = miss.filter((m) => m.kind === 'layer').length;
    const other = miss.length - layers;
    const counts = {};
    miss.forEach((m) => { counts[m.reason.code] = (counts[m.reason.code] || 0) + 1; });
    const head = layers
      ? `${layers} of ${plural(p.layers, 'layer')} not cached${other ? ' (and the image config)' : ''}`
      : 'The image config is not cached';
    const why = Object.entries(counts).map(([c, n]) => `${n} ${REASON_SHORT[c] || c}`).join(', ');
    return `${head}: ${why}.`;
  }

  /* ------------------------------------------------------------ renderers */
  function renderHero() {
    const el = $('#hero');
    if (!state.data) {
      el.innerHTML = '<div><p class="lede">Scanning the cache…</p></div>';
      return;
    }
    const regs = inScope();
    const total = regs.reduce((s, r) => s + r.disk_bytes, 0);
    const images = regs.reduce((s, r) => s + r.repo_count, 0);
    const tags = regs.reduce((s, r) => s + r.tag_count, 0);
    const p = fmtParts(total);
    const d = state.data.disk;
    const lede = state.reg === 'all'
      ? `on disk across ${plural(regs.length, 'registry')}, holding ${plural(images, 'image')} and ${plural(tags, 'tag')}.`
      : `on disk for ${esc(regs[0] ? regs[0].name : '')}, holding ${plural(images, 'image')} and ${plural(tags, 'tag')}.`;
    const pct = d && d.total ? Math.min(100, (d.used / d.total) * 100) : 0;
    el.innerHTML = `
      <div>
        <div class="figure"><span class="big">${p.v}</span><span class="unit">${p.u}</span></div>
        <p class="lede">${lede}</p>
      </div>
      ${d ? `<div class="volume">
        <div class="meter" role="img" aria-label="${pct.toFixed(0)}% of the cache volume is used"><i style="width:${pct}%"></i></div>
        <p>${fmtBytes(d.free)} free of ${fmtBytes(d.total)} on the cache volume.</p>
      </div>` : ''}`;
  }

  function renderStrip() {
    const el = $('#strip');
    const rows = allRows().filter((r) => r.repo.size > 0).sort((a, b) => b.repo.size - a.repo.size);
    const total = rows.reduce((s, r) => s + r.repo.size, 0);
    if (!total) { el.innerHTML = ''; return; }
    const top = rows.slice(0, MAX_SEGMENTS);
    const rest = rows.slice(MAX_SEGMENTS).reduce((s, r) => s + r.repo.size, 0);
    const seg = top.map((r) => {
      const share = (r.repo.size / total) * 100;
      const short = r.repo.name.split('/').pop();
      return `<button class="seg" type="button" style="flex-grow:${r.repo.size};--c:${colorOf(r.ri)}"
        data-seg="${esc(r.key)}" data-label="${esc(r.repo.name)}" data-size="${r.repo.size}"
        aria-label="${esc(r.repo.name)}, ${fmtBytes(r.repo.size)}">${share >= 7 ? esc(short) : ''}</button>`;
    }).join('');
    const other = rest
      ? `<button class="seg other" type="button" style="flex-grow:${rest}" tabindex="-1"
          data-label="${plural(rows.length - top.length, 'smaller image')}" data-size="${rest}"></button>`
      : '';
    el.innerHTML = `<div class="strip" role="group" aria-label="Largest images by size">${seg}${other}</div>
      <p class="strip-cap" id="cap">The largest images, drawn to scale. Select a block to find it in the list.</p>`;
  }

  function renderRail() {
    const el = $('#rail');
    const regs = registries();
    const total = regs.reduce((s, r) => s + r.disk_bytes, 0) || 1;
    const item = (id, name, meta, size, share, color, extra = '') => `
      <button class="reg ${extra}" type="button" data-reg="${esc(id)}" style="--c:${color}"
        aria-pressed="${state.reg === id}">
        <span class="reg-top"><span>${esc(name)}</span><span class="reg-size">${fmtBytes(size)}</span></span>
        <span class="reg-meta">${meta}</span>
        <span class="share"><i style="width:${(share * 100).toFixed(1)}%"></i></span>
      </button>`;
    el.innerHTML = item('all', 'All registries',
      `${plural(regs.reduce((s, r) => s + r.repo_count, 0), 'image')}`, regs.reduce((s, r) => s + r.disk_bytes, 0), 1, 'var(--ink)', 'all')
      + regs.map((r, i) => item(r.id, r.name,
        `${esc(r.upstream || 'unknown upstream')}, ${plural(r.repo_count, 'image')}`,
        r.disk_bytes, r.disk_bytes / total, colorOf(i))).join('');
  }

  function renderBulk() {
    const btn = $('#bulk');
    const regs = inScope();
    const anything = regs.some((r) => r.repo_count > 0 || r.disk_bytes > 0);
    btn.hidden = !canDelete() || !state.data || !anything;
    if (btn.hidden) return;
    btn.textContent = state.reg === 'all' ? 'Delete entire cache…' : `Delete all in ${regs[0].name}…`;
  }

  function th(key, label, cls = '') {
    if (!key) return `<th class="${cls}">${label}</th>`;
    const active = state.sort.key === key;
    const dir = state.sort.dir === 'asc' ? 'ascending' : 'descending';
    return `<th class="${cls}" ${active ? `aria-sort="${dir}"` : ''}>
      <button class="sort" type="button" data-sort="${key}">${label}<span class="dir" aria-hidden="true">${state.sort.dir === 'asc' ? '▲' : '▼'}</span></button></th>`;
  }

  function chips(list) {
    return list.length
      ? `<span class="chips">${list.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</span>`
      : '<span class="muted">none</span>';
  }

  function deleteButton(scope, regId, repo, tag, label) {
    if (!canDelete()) return '';
    return `<button class="icon-btn small" type="button" data-del-scope="${scope}" data-del-reg="${esc(regId)}"
      data-del-repo="${esc(repo)}" data-del-tag="${esc(tag || '')}" aria-label="${esc(label)}" title="${esc(label)}">${ICON_TRASH}</button>`;
  }

  function platformCell(row, t) {
    const whole = [];
    const gappy = [];
    t.platforms.filter((p) => !isIdle(p)).forEach((p) => ((p.missing && p.missing.length) ? gappy : whole).push(p));
    let html = '';
    if (whole.length) html += `<span class="chips">${whole.map((p) => `<span class="chip">${esc(p.platform)}</span>`).join('')}</span>`;
    gappy.forEach((p) => {
      const cls = p.cached ? 'chip partial' : 'chip ghost';
      html += `<span class="plat"><span class="${cls}">${esc(p.platform)}</span>
        <span class="gap">${esc(gapSummary(p))}
        <button class="linkbtn inline" type="button" data-gaps="${esc(`${row.reg.id}|${row.repo.name}|${t.name}`)}">Details</button></span></span>`;
    });
    if (!html) html = t.platforms.length ? '<span class="muted">none pulled yet</span>' : '<span class="chip ghost">manifest missing</span>';
    return `<div class="plats">${html}</div>`;
  }

  function activityCell(row, t) {
    if (!tracking().enabled) return '<span class="muted">not tracked</span>';
    const a = t.activity;
    if (!a || (!a.initial && !a.later_total)) return '<span class="muted">none recorded</span>';
    const who = a.initial ? esc(hostLabel(a.initial)) : 'Not recorded';
    const more = a.later_total
      ? `${plural(a.later_total, 'later pull')} from ${plural(a.later.length, 'host')}`
      : 'no later pulls';
    return `<button class="linkbtn" type="button" data-hosts="${esc(`${row.reg.id}|${row.repo.name}|${t.name}`)}">
      <span class="who-main">${who}</span><span class="sub">${more}</span></button>`;
  }

  function tagRows(row) {
    const { reg, repo } = row;
    return repo.tags.map((t) => {
      const cmd = pullRef(reg, repo.name, t.name);
      return `<tr>
        <td class="tagname" title="${esc(t.digest)}">${esc(t.name)}</td>
        <td>${platformCell(row, t)}</td>
        <td class="num">${fmtBytes(t.size)}</td>
        <td>${activityCell(row, t)}</td>
        <td class="num hide-sm" title="${esc(t.built || '')}">${t.built ? builtAgo(t.built) : '<span class="muted">unknown</span>'}</td>
        <td class="num" title="${esc(absTime(t.updated))}">${ago(t.updated)}</td>
        <td class="num hide-md"><span class="digest" title="${esc(t.digest)}">${esc(shortDigest(t.digest))}</span></td>
        <td class="act">${cmd ? `<button class="copy" type="button" data-copy="${esc(cmd)}" aria-label="Copy pull command for ${esc(repo.name)}:${esc(t.name)}" title="Copy pull command">${ICON_COPY}</button>` : ''}${deleteButton('tag', reg.id, repo.name, t.name, `Delete ${repo.name}:${t.name} from the cache`)}</td>
      </tr>`;
    }).join('');
  }

  function renderTable() {
    const el = $('#table');
    if (!state.data) {
      el.innerHTML = '<div class="empty"><p>Scanning the cache…</p></div>';
      $('#count').textContent = '';
      return;
    }
    const rows = filteredRows();
    const everything = allRows();
    $('#count').textContent = everything.length ? `${plural(rows.length, 'image')} shown` : '';

    if (!everything.length) {
      el.innerHTML = `<div class="empty"><h2>Nothing cached yet</h2>
        <p>Pull an image through the cache and it will appear here after the next scan.</p>
        <button class="btn primary" type="button" data-action="connect">See how to connect a client</button></div>`;
      return;
    }
    if (!rows.length) {
      el.innerHTML = `<div class="empty"><h2>No matches</h2><p>No image or tag matches “${esc(state.q)}”.</p></div>`;
      return;
    }

    const max = Math.max(...rows.map((r) => r.repo.size), 1);
    const body = rows.map((r) => {
      const open = state.open.has(r.key);
      return `<tr class="row" data-row="${esc(r.key)}">
        <td>
          <button class="twirl" type="button" data-toggle="${esc(r.key)}" aria-expanded="${open}">
            ${ICON_CHEVRON}<span class="dot" style="--c:${colorOf(r.ri)}"></span><span class="repo">${esc(r.repo.name)}</span>
          </button>
          ${state.reg === 'all' ? `<span class="regname">${esc(r.reg.name)}</span>` : ''}
        </td>
        <td class="num">${r.repo.tags.length}</td>
        <td class="hide-sm">${chips(platformsOf(r.repo))}</td>
        <td class="num"><span class="sizecell"><span class="bar" style="--c:${colorOf(r.ri)}"><i style="width:${(r.repo.size / max) * 100}%"></i></span>${fmtBytes(r.repo.size)}</span></td>
        <td class="num" title="${esc(absTime(r.repo.updated))}">${ago(r.repo.updated)}</td>
        <td class="act">${deleteButton('repo', r.reg.id, r.repo.name, '', `Delete all tags of ${r.repo.name} from the cache`)}</td>
      </tr>${open ? `<tr class="detail"><td colspan="6">
        <div class="table-wrap-inner"><table class="tags"><thead><tr><th>Tag</th><th>Platforms</th><th class="num">Size</th><th>First pulled by</th><th class="num hide-sm">Built</th><th class="num">Cached</th><th class="num hide-md">Digest</th><th></th></tr></thead>
        <tbody>${tagRows(r)}</tbody></table></div></td></tr>` : ''}`;
    }).join('');

    el.innerHTML = `<table><thead><tr>${th('name', 'Image')}${th('tags', 'Tags', 'num')}<th class="hide-sm">Platforms</th>${th('size', 'Size', 'num')}${th('updated', 'Cached', 'num')}<th class="act"></th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderFoot() {
    const el = $('#foot');
    if (!state.data || !state.data.scanned_at) { el.textContent = ''; return; }
    const d = state.data;
    el.innerHTML = `Scanned ${ago(d.scanned_at)} in ${d.scan_seconds} s${d.scanning ? ' (rescanning now)' : ''}. `
      + 'Sizes are the compressed bytes stored on disk; layers shared between images are counted once per image and once on disk. '
      + (d.ca_available ? '<a href="/ca.crt">Download the root certificate</a>.' : '');
  }

  function renderBanner() {
    const el = $('#banner');
    const msg = state.error || (state.data && state.data.error);
    el.hidden = !msg;
    el.textContent = msg ? `The scan failed: ${msg}. Check that the cache folder is mounted and readable, then rescan.` : '';
  }

  function render() {
    renderBanner();
    renderHero();
    renderStrip();
    renderRail();
    renderBulk();
    renderTable();
    renderFoot();
  }

  /* ------------------------------------------------------------- loading */
  async function load(force) {
    const btn = $('#refresh');
    if (force) { btn.disabled = true; btn.textContent = 'Scanning…'; }
    try {
      const res = await fetch(force ? '/api/refresh' : '/api/cache', {
        method: force ? 'POST' : 'GET', cache: 'no-store',
      });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      state.data = await res.json();
      state.error = null;
    } catch (err) {
      state.error = err.message || String(err);
    }
    if (force) { btn.disabled = false; btn.textContent = 'Rescan'; }
    if (state.reg !== 'all' && !registries().some((r) => r.id === state.reg)) state.reg = 'all';
    render();
  }

  /* -------------------------------------------------------------- toast */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    toast('Copied to clipboard');
  }

  /* ---------------------------------------------------------- dialogs */
  function codeBlock(text) {
    return `<div class="code"><pre>${esc(text)}</pre>
      <button class="copy" type="button" data-copy="${esc(text)}" aria-label="Copy command" title="Copy">${ICON_COPY}</button></div>`;
  }

  function showDialog(id, titleId, title, bodyHtml, headClass = '') {
    const dlg = $(id);
    dlg.innerHTML = `
      <div class="dlg-head ${headClass}"><h2 id="${titleId}">${title}</h2>
        <button class="btn" type="button" data-action="close">Close</button></div>
      <div class="dlg-body">${bodyHtml}</div>`;
    if (!dlg.open) dlg.showModal();
    return dlg;
  }

  /* ---- connect */
  function openConnect() {
    const d = state.data || {};
    const regs = registries().filter((r) => r.endpoint);
    const hosts = regs.map((r) => r.endpoint);
    const h = location.hostname.replace(/^\[|\]$/g, '');
    const ip = /^[\d.]+$/.test(h) || h.includes(':') ? h : '<server-ip>';

    const trust = d.ca_available
      ? `<p>Download the root certificate, then tell Docker to trust it for each registry name. Trusting it for the whole machine is covered in the README.</p>
         <p><a class="btn primary" href="/ca.crt" style="display:inline-block;text-decoration:none">Download root certificate</a></p>
         ${codeBlock(`for h in ${hosts.join(' ')}; do\n  sudo install -D -m 644 registry-cache-ca.crt /etc/docker/certs.d/$h/ca.crt\ndone`)}`
      : `<p>No root certificate is published by this server, because you supplied a server certificate without <code>ca.crt</code>.
         Clients must already trust whatever issued it.</p>`;

    const examples = regs.map((r) => (isHub(r)
      ? '# Docker Hub\ndocker pull alpine:3.20'
      : `# ${r.name}\ndocker pull ${r.endpoint}/owner/image:tag`)).join('\n\n');

    showDialog('#dlg', 'dlg-title', 'Connect a client', `
      <p>Nothing changes in image names or commands. The registries' own hostnames are pointed at this server,
      and the cache is chosen by the name the client asks for.</p>
      <h3>1. Point the registry names at this server</h3>
      <p>On your DNS server (dnsmasq syntax shown), or in <code>/etc/hosts</code> on each client:</p>
      ${codeBlock(hosts.map((x) => `address=/${x}/${ip}`).join('\n'))}
      ${codeBlock(`${ip} ${hosts.join(' ')}`)}
      <h3>2. Trust the certificate</h3>${trust}
      <h3>3. Pull as usual</h3>
      ${codeBlock(examples || '# No registries are configured.')}`);
  }

  /* ---- who pulled it */
  function openHosts(key) {
    const [regId, repoName, tagName] = key.split('|');
    const { reg, tag } = findTag(regId, repoName, tagName);
    if (!tag) return;
    const a = tag.activity || { initial: null, later: [], later_total: 0 };
    const since = tracking().since;

    const initial = a.initial
      ? `<div class="who">
           <div class="who-name">${esc(hostLabel(a.initial))}</div>
           ${a.initial.name ? `<p class="muted">${esc(a.initial.ip)}</p>` : ''}
           <p>${esc(absTime(a.initial.t))}, ${ago(a.initial.t)}${a.initial.ua ? `, using ${esc(a.initial.ua)}` : ''}</p>
         </div>`
      : `<p class="note warn-note">The request that first cached this image was not recorded. It was probably cached before tracking started${since ? ` on ${esc(absDate(since))}` : ''}, or its log entry has since been rotated away. Later pulls are still listed below.</p>`;

    const later = a.later.length
      ? `<div class="table-wrap"><table class="mini"><thead><tr><th>Host</th><th class="num">Pulls</th><th>Last pull</th><th>Client</th></tr></thead><tbody>
          ${a.later.map((h) => `<tr>
            <td>${esc(hostLabel(h))}${h.name ? `<div class="muted">${esc(h.ip)}</div>` : ''}</td>
            <td class="num">${h.n}</td>
            <td title="${esc(absTime(h.last))}">${ago(h.last)}</td>
            <td>${h.ua ? esc(h.ua) : '<span class="muted">unknown</span>'}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="muted">No one has pulled it again since.</p>';

    showDialog('#info', 'info-title', `Pull history for ${esc(repoName)}:${esc(tagName)}`, `
      <p>${esc(reg.name)}. A pull counts once even though the client sends several requests for it.</p>
      <h3>First pulled by</h3>${initial}
      <h3>Later pulls, served from the cache${a.later_total ? ` (${a.later_total})` : ''}</h3>${later}
      <p class="note">Hosts are the client addresses the cache saw. Behind Docker Desktop, a NAT or another proxy they can show that device's address instead.
      Give addresses friendly names in <code>clients.conf</code>.${since ? ` Tracking has been recording since ${esc(absDate(since))}.` : ''}</p>`);
  }

  /* ---- why layers are missing */
  function openGaps(key) {
    const [regId, repoName, tagName] = key.split('|');
    const { reg, tag } = findTag(regId, repoName, tagName);
    if (!tag) return;
    const kind = { manifest: 'Platform manifest', config: 'Image config', layer: 'Layer' };
    const blocks = tag.platforms.filter((p) => p.missing && p.missing.length && !isIdle(p)).map((p) => `
      <h3>${esc(p.platform)}</h3>
      <div class="table-wrap"><table class="mini"><thead><tr><th>Item</th><th>Digest</th><th class="num">Size</th><th>Why it is not cached</th></tr></thead><tbody>
        ${p.missing.map((m) => `<tr>
          <td>${kind[m.kind] || esc(m.kind)}</td>
          <td><span class="digest" title="${esc(m.digest)}">${esc(shortDigest(m.digest))}</span></td>
          <td class="num">${m.size != null ? fmtBytes(m.size) : 'unknown'}</td>
          <td class="reason">${esc(reasonText(m.reason))}</td></tr>`).join('')}
      </tbody></table></div>`).join('');

    showDialog('#info', 'info-title', `Why some of ${esc(repoName)}:${esc(tagName)} is not cached`, `
      <p>${esc(reg.name)}. A pull-through cache stores only what clients actually request, so a manifest can list more than is on disk.
      The image still pulls normally: missing parts are fetched from the upstream registry when a client asks for them.</p>
      ${blocks}`);
  }

  /* ---- delete */
  function describeDelete(op) {
    const regs = registries();
    const reg = regs.find((r) => r.id === op.registry);
    const note = 'Layers that other cached images also use are kept.';
    if (op.scope === 'tag') {
      const { tag } = findTag(op.registry, op.repo, op.tag);
      return { title: `Delete ${esc(op.repo)}:${esc(op.tag)}?`, bulk: false,
        lead: `This removes the tag <b>${esc(op.tag)}</b> of <b>${esc(op.repo)}</b> (${esc(reg ? reg.name : op.registry)}) from the cache.`,
        facts: [`Up to <b>${fmtBytes(tag ? tag.size : 0)}</b> is freed.`, note] };
    }
    if (op.scope === 'repo') {
      const repo = reg && reg.repos.find((r) => r.name === op.repo);
      return { title: `Delete ${esc(op.repo)}?`, bulk: false,
        lead: `This removes <b>${esc(op.repo)}</b> (${esc(reg ? reg.name : op.registry)}) and all of its tags from the cache.`,
        facts: [`<b>${plural(repo ? repo.tags.length : 0, 'tag')}</b>, up to <b>${fmtBytes(repo ? repo.size : 0)}</b> freed.`, note] };
    }
    if (op.scope === 'registry') {
      return { title: `Delete everything cached for ${esc(reg ? reg.name : op.registry)}?`, bulk: true,
        what: `every image cached for ${esc(reg ? reg.name : op.registry)}`,
        lead: `This removes <b>every image</b> cached for <b>${esc(reg ? reg.name : op.registry)}</b>.`,
        facts: [`<b>${plural(reg ? reg.repo_count : 0, 'image')}</b> and <b>${plural(reg ? reg.tag_count : 0, 'tag')}</b>, <b>${fmtBytes(reg ? reg.disk_bytes : 0)}</b> freed.`,
          'Other registries are not touched.'] };
    }
    const imgs = regs.reduce((s, r) => s + r.repo_count, 0);
    const tags = regs.reduce((s, r) => s + r.tag_count, 0);
    const bytes = regs.reduce((s, r) => s + r.disk_bytes, 0);
    return { title: 'Delete the entire cache?', bulk: true, what: 'the entire cache, for every registry',
      lead: 'This removes <b>everything</b> from <b>every registry</b>.',
      facts: [`<b>${plural(imgs, 'image')}</b> and <b>${plural(tags, 'tag')}</b> across <b>${plural(regs.length, 'registry')}</b>, <b>${fmtBytes(bytes)}</b> freed.`,
        'The registry list and your settings are kept.'] };
  }

  function openConfirm(op) {
    const d = describeDelete(op);
    const needsToken = !!(state.data.capabilities && state.data.capabilities.token);
    let saved = '';
    try { saved = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* storage blocked */ }
    const dlg = $('#confirm');
    dlg.innerHTML = `
      <div class="dlg-head warn"><h2 id="confirm-title">${ICON_WARN}${d.title}</h2></div>
      <div class="dlg-body">
        <p class="lead">${d.lead}</p>
        <ul class="facts">${d.facts.map((f) => `<li>${f}</li>`).join('')}</ul>
        <div class="warnbox"><b>This cannot be undone.</b> Clients will fetch these images from the upstream registry again the next
        time they pull, which counts against its rate limits. Pulls running right now may fail and need a retry.</div>
        ${d.bulk ? `<label class="check"><input type="checkbox" id="understand"><span>I understand that this deletes ${d.what}.</span></label>` : ''}
        ${needsToken ? `<label class="field">Admin token<input type="password" id="token" autocomplete="off" value="${esc(saved)}"></label>` : ''}
        <p class="error" id="del-error" role="alert" hidden></p>
        <div class="dlg-actions">
          <button class="btn" type="button" id="cancel-delete" autofocus>Cancel</button>
          <button class="btn danger" type="button" id="do-delete" ${d.bulk ? 'disabled' : ''}>Delete</button>
        </div>
      </div>`;
    const go = $('#do-delete', dlg);
    const box = $('#understand', dlg);
    if (box) box.addEventListener('change', () => { go.disabled = !box.checked; });
    $('#cancel-delete', dlg).addEventListener('click', () => dlg.close());
    go.addEventListener('click', () => submitDelete(op, dlg, go));
    dlg.showModal();
  }

  async function submitDelete(op, dlg, go) {
    const err = $('#del-error', dlg);
    err.hidden = true;
    go.disabled = true;
    go.textContent = 'Deleting…';
    const headers = { 'Content-Type': 'application/json', 'X-Registry-Cache': '1' };
    const tokenInput = $('#token', dlg);
    if (tokenInput) {
      headers.Authorization = `Bearer ${tokenInput.value}`;
      try { sessionStorage.setItem(TOKEN_KEY, tokenInput.value); } catch (e) { /* storage blocked */ }
    }
    try {
      const res = await fetch('/api/delete', { method: 'POST', headers, body: JSON.stringify(op) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `server answered ${res.status}`);
      state.data = body.snapshot;
      state.open = new Set([...state.open].filter((k) => {
        const [r, ...rest] = k.split('/');
        return registries().some((g) => g.id === r && g.repos.some((p) => p.name === rest.join('/')));
      }));
      dlg.close();
      render();
      const freed = fmtBytes(body.result.freed_bytes);
      const what = op.scope === 'tag' ? `${op.repo}:${op.tag}` : op.scope === 'repo' ? op.repo
        : op.scope === 'registry' ? 'that registry' : 'the entire cache';
      toast(`Deleted ${what}, freed ${freed}`);
    } catch (e) {
      err.textContent = e.message || String(e);
      err.hidden = false;
      go.disabled = false;
      go.textContent = 'Delete';
      if (/token/i.test(err.textContent)) { try { sessionStorage.removeItem(TOKEN_KEY); } catch (x) { /* ignore */ } }
    }
  }

  /* -------------------------------------------------------------- events */
  function reveal(key) {
    state.open.add(key);
    state.q = '';
    $('#q').value = '';
    render();
    const row = document.querySelector(`[data-row="${CSS.escape(key)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      row.classList.add('flash');
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-reg],[data-toggle],[data-sort],[data-copy],[data-seg],[data-action],[data-hosts],[data-gaps],[data-del-scope]');
    if (!t) return;
    if (t.dataset.reg !== undefined) { state.reg = t.dataset.reg; render(); }
    else if (t.dataset.toggle !== undefined) {
      const k = t.dataset.toggle;
      state.open.has(k) ? state.open.delete(k) : state.open.add(k);
      renderTable();
    } else if (t.dataset.sort) {
      const key = t.dataset.sort;
      state.sort = state.sort.key === key
        ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' };
      renderTable();
    } else if (t.dataset.copy) copyText(t.dataset.copy);
    else if (t.dataset.seg) reveal(t.dataset.seg);
    else if (t.dataset.hosts) openHosts(t.dataset.hosts);
    else if (t.dataset.gaps) openGaps(t.dataset.gaps);
    else if (t.dataset.delScope) {
      openConfirm({ scope: t.dataset.delScope, registry: t.dataset.delReg, repo: t.dataset.delRepo || undefined, tag: t.dataset.delTag || undefined });
    } else if (t.dataset.action === 'connect') openConnect();
    else if (t.dataset.action === 'close') t.closest('dialog').close();
  });

  // Caption under the strip follows hover and keyboard focus.
  function strip(e) {
    const seg = e.target.closest && e.target.closest('.seg');
    const cap = $('#cap');
    if (!cap) return;
    cap.innerHTML = seg
      ? `<b>${esc(seg.dataset.label)}</b>, ${fmtBytes(Number(seg.dataset.size))}`
      : 'The largest images, drawn to scale. Select a block to find it in the list.';
  }
  document.addEventListener('mouseover', strip);
  document.addEventListener('focusin', strip);
  document.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('.seg')) strip({ target: document.body }); });

  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  });
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
  $('#refresh').addEventListener('click', () => load(true));
  $('#connect').addEventListener('click', openConnect);
  $('#bulk').addEventListener('click', () => {
    if (state.reg === 'all') openConfirm({ scope: 'all' });
    else openConfirm({ scope: 'registry', registry: state.reg });
  });
  $('#theme').addEventListener('click', () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true));

  // Follow the operating system until the person makes an explicit choice.
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!storedTheme()) applyTheme(e.matches ? 'dark' : 'light', false);
    });
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
  setInterval(() => { if (!document.hidden && !$('dialog[open]')) load(false); }, POLL_MS);
  setInterval(renderFoot, 10000);

  applyTheme(root.dataset.theme, false);
  render();
  load(false);
})();
