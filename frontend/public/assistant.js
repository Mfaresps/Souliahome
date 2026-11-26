/* «مساعد SOULIA» — the question panel beside every page.
 *
 * The browser only draws. The server understands the question, checks the asker's permissions and
 * reads the same report functions the pages use (backend/src/assistant). Nothing here computes a
 * figure, so a number in the chat always equals the number on the page it cites.
 *
 * Pieces (ideas from Hirael's Reasoning and Sources components, rebuilt without React):
 *  • «طريقة الإجابة» — a fold that shimmers while the server works, then closes into
 *    «تمت الإجابة في 0.3 ث» and lists what was understood and which report was read.
 *  • Numbered citations beside each figure (hover/focus previews the source, click opens the page),
 *    and an «استُخدم مصدران» line that opens into the list of sources.
 *  • «ليس هذا ما أقصده» flags a wrong understanding; admins review those in «أسئلة تحتاج مراجعة».
 */
(function () {
  'use strict';
  const ar = () => (typeof currentLang === 'undefined' || currentLang !== 'en');
  const T = (a, e) => (ar() ? a : e);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => { try { return String(currentUser?._id || currentUser?.id || currentUser?.username || ''); } catch (_) { return ''; } };
  const admin = () => { try { return typeof isAdmin === 'function' && isAdmin(); } catch (_) { return false; } };
  // The chat is a permission the admin grants per role («استخدام مساعد SOULIA», key `assistant`); the
  // server refuses every question without it, so the button is not drawn for those accounts.
  const allowed = () => { try { return !!uid() && (admin() || (typeof hasPerm === 'function' && hasPerm('assistant'))); } catch (_) { return false; } };
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ICON = {
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    steps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11h10.2l2-8H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h11l-1.5 4L16 12H5"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 20h16M7 16v-5M12 16V8M17 16v-8"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12.5h2"/><path d="M3 9h18"/></svg>',
    // The external assistant: a person-like mark with an outward arrow — never the system's spark.
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 5h5v5M21 5l-6 6"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4M3 8h13M17 12l4 4-4 4M21 16H8"/></svg>',
  };

  const STORE_KEY = () => 'soulia_ai_chat_v1:' + uid();
  // target: who answers the next question — 'system' (this assistant, the default) or 'external'
  // (Instinct, by email). Every message keeps the target it was sent to; nothing moves on its own.
  const state = { open: false, view: 'chat', busy: false, msgs: [], seq: 0, target: 'system', chatId: '' };
  const rand = (n) => { const a = new Uint8Array(n); (window.crypto || window.msCrypto).getRandomValues(a); return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63]).join(''); };
  const newChatId = () => 'chat_' + rand(12);

  // ── Persistence (per user, this browser session only) ─────────────────────────────────────────
  function save() { try { sessionStorage.setItem(STORE_KEY(), JSON.stringify({ chatId: state.chatId, msgs: state.msgs.slice(-40) })); } catch (_) {} }
  function restore() {
    try {
      const v = JSON.parse(sessionStorage.getItem(STORE_KEY()) || '[]');
      // Older sessions stored the message list alone.
      state.msgs = Array.isArray(v) ? v : (Array.isArray(v && v.msgs) ? v.msgs : []);
      state.chatId = (v && !Array.isArray(v) && /^[A-Za-z0-9_-]{6,64}$/.test(v.chatId || '')) ? v.chatId : newChatId();
    } catch (_) { state.msgs = []; state.chatId = newChatId(); }
  }
  const chatId = () => { if (!state.chatId) state.chatId = newChatId(); return state.chatId; };

  // ── Formatting ────────────────────────────────────────────────────────────────────────────────
  function money(v) {
    const n = Math.round(Number(v) || 0);
    if (typeof fmtJ === 'function') return fmtJ(n);
    return `<span class="amt-cur">EGP</span> <span class="amt-num">${n.toLocaleString('en-US')}</span>`;
  }
  function fmtVal(v, f) {
    if (v == null) return '—';
    if (f === 'money') return money(v);
    if (f === 'pct') return `<bdi class="ai-num">${(Number(v) || 0).toFixed(1)}%</bdi>`;
    if (f === 'dec') { const n = Number(v) || 0; return `<bdi class="ai-num">${n > 0 && n < 0.1 ? '<0.1' : n.toFixed(1)}</bdi>`; }
    return `<bdi class="ai-num">${Math.round(Number(v) || 0).toLocaleString('en-US')}</bdi>`;
  }
  /** The answer as plain text for «نسخ» — the same figures the card shows, without the source marks. */
  function valText(v, f) {
    if (v == null) return '—';
    const n = Number(v) || 0;
    if (f === 'money') return `${Math.round(n).toLocaleString('en-US')} EGP`;
    if (f === 'pct') return `${n.toFixed(1)}%`;
    if (f === 'dec') return n > 0 && n < 0.1 ? '<0.1' : n.toFixed(1);
    return Math.round(n).toLocaleString('en-US');
  }
  function cellText(c) {
    if (c == null) return '';
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if ('v' in c) return valText(c.v, c.f);
    const main = Array.isArray(c.links) ? c.links.map((x) => x.t).join(ar() ? '، ' : ', ') : String(c.t || '');
    return c.sub ? `${main} (${c.sub})` : main;
  }
  function answerText(a) {
    const out = [];
    const lead = (a.lead || []).map((s) => typeof s === 'string' ? s : s && 'b' in s ? s.b : valText(s.v, s.f)).join('').trim();
    if (lead) out.push(lead);
    if (a.kpis && a.kpis.length) out.push(a.kpis.map((k) => `${k.label}: ${k.delta !== undefined ? (k.delta == null ? '—' : `${k.delta >= 0 ? '+' : '−'}${Math.abs(k.delta).toFixed(1)}%`) : (k.text || valText(k.v, k.f))}`).join('\n'));
    if (a.plan && a.plan.groups) a.plan.groups.forEach((g) => out.push([g.title, ...g.rows.map((r) => `- ${r.name} (${r.code}): ${T('اشترِ', 'buy')} ${r.buy}`)].join('\n')));
    if (a.table && a.table.rows.length) out.push([a.table.cols.map((c) => c.label).join(' | '), ...a.table.rows.map((r) => r.map(cellText).join(' | '))].join('\n'));
    if (a.points && a.points.length) out.push([a.pointsTitle || '', ...a.points.map((p) => `- ${p.t}${p.sub ? ` — ${p.sub}` : ''}`)].filter(Boolean).join('\n'));
    if (a.note) out.push(a.note);
    if (a.options && a.options.length) out.push(a.options.map((o) => `- ${o}`).join('\n'));
    return out.join('\n\n');
  }
  /** An external reply as plain text: title, summary, tables, links. */
  function extText(r) {
    const out = [];
    if (r.title) out.push(r.title);
    if (r.summary) out.push(r.summary);
    (r.tables || []).forEach((t) => out.push([t.caption || '', t.columns.join(' | '), ...t.rows.map((row) => row.join(' | '))].filter(Boolean).join('\n')));
    if (r.sourceLinks && r.sourceLinks.length) out.push(r.sourceLinks.map((l) => `- ${l.label}: ${l.url}`).join('\n'));
    return out.join('\n\n');
  }
  async function copyAnswer(mi, btn) {
    const m = state.msgs[mi];
    const reply = m && m.kind === 'ext' && m.ext && m.ext.reply;
    if (!m || (!m.a && !reply)) return;
    const text = reply ? extText(reply) : answerText(m.a);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      // Plain-http LAN: no clipboard API — fall back to a hidden textarea.
      try { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;inset-inline-start:-9999px'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (_) {}
    }
    if (!ok) { if (typeof toast === 'function') toast(T('تعذّر النسخ.', 'Could not copy.'), true); return; }
    btn.classList.add('is-done');
    btn.innerHTML = `${ICON.check}<span>${esc(T('تم النسخ', 'Copied'))}</span>`;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('is-done'); btn.innerHTML = `${ICON.copy}<span>${esc(T('نسخ', 'Copy'))}</span>`; }, 1600);
  }
  // A raised, outlined source mark — never inline at figure size, or «11 ¹» reads as «111».
  const cite = (n, mi) => n ? `<sup class="ai-cite-wrap"><button type="button" class="ai-cite" data-cite="${n}" data-mi="${mi}" aria-label="${esc(T('افتح المصدر ', 'Open source ') + n)}">${ICON.link}</button></sup>` : '';
  function segs(list, mi) {
    return (list || []).map((s) => {
      if (typeof s === 'string') return esc(s);
      if (s && 'b' in s) return `<b>${esc(s.b)}</b>`;
      return `<b class="ai-fig">${fmtVal(s.v, s.f)}</b>${cite(s.cite, mi)}`;
    }).join('');
  }
  function cell(c, num) {
    if (c == null) return '<td></td>';
    if (typeof c === 'string' || typeof c === 'number') return `<td class="${num ? 'num' : ''}">${num ? `<bdi class="ai-num">${esc(c)}</bdi>` : esc(c)}</td>`;
    if ('v' in c) return `<td class="num">${fmtVal(c.v, c.f)}</td>`;
    if (Array.isArray(c.links)) {
      const items = c.links.map((x) => x.link
        ? `<button type="button" class="ai-tlink" data-link='${esc(JSON.stringify(x.link))}'><bdi>${esc(x.t)}</bdi></button>`
        : `<bdi>${esc(x.t)}</bdi>`).join(`<span class="ai-sep">${ar() ? '، ' : ', '}</span>`);
      return `<td><span class="ai-links">${items}</span>${c.sub ? `<small dir="auto">${esc(c.sub)}</small>` : ''}</td>`;
    }
    const tone = c.tone ? ` is-${c.tone}` : '';
    const main = c.link ? `<button type="button" class="ai-tlink" data-link='${esc(JSON.stringify(c.link))}'>${esc(c.t)}</button>` : esc(c.t);
    const sub = c.sub ? `<small><bdi>${esc(c.sub)}</bdi></small>` : '';
    return `<td class="${num ? 'num' : ''}${tone}">${num ? `<bdi class="ai-num">${main}</bdi>` : main}${sub}</td>`;
  }
  const sourcesLabel = (n) => ar()
    ? (n === 1 ? 'استُخدم مصدر واحد' : n === 2 ? 'استُخدم مصدران' : `استُخدمت ${n} مصادر`)
    : `Used ${n} source${n === 1 ? '' : 's'}`;
  const secs = (ms) => { const s = (Number(ms) || 0) / 1000; return s < 0.1 ? '0.1' : s.toFixed(1); };

  // ── Rendering ─────────────────────────────────────────────────────────────────────────────────
  function answerHtml(m, mi) {
    const a = m.a;
    if (!a) return '';
    const st = a.status;
    const reasoning = (a.steps && a.steps.length) ? `
      <div class="ai-reason${m.reasonOpen ? ' is-open' : ''}">
        <button type="button" class="ai-reason-btn" data-reason="${mi}" aria-expanded="${m.reasonOpen ? 'true' : 'false'}">
          ${ICON.steps}<span>${esc(T('فكّر لمدة', 'Thought for'))} <bdi>${secs(a.ms)}</bdi> ${esc(T('ث', 's'))}</span>${ICON.chev}
        </button>
        <div class="ai-reason-body"><div><ol>${a.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div></div>
      </div>` : '';
    const lead = `<p class="ai-lead">${st === 'denied' ? `<span class="ai-lock">${ICON.lock}</span>` : ''}${segs(a.lead, mi)}</p>`;
    const kpis = a.kpis && a.kpis.length ? `<div class="ai-kpis">${a.kpis.map((k) => `
      <div class="ai-kpi"><span class="ai-kpi-l">${esc(k.label)}</span>
        <span class="ai-kpi-v">${k.delta !== undefined
          ? (k.delta == null ? '—' : `<span class="ai-delta ${k.delta >= 0 ? 'is-up' : 'is-down'}">${k.delta >= 0 ? '▲' : '▼'} <bdi>${Math.abs(k.delta).toFixed(1)}%</bdi></span>`)
          : (k.text ? esc(k.text) : fmtVal(k.v, k.f))}</span></div>`).join('')}</div>` : '';
    const table = a.table ? `<div class="ai-tbl"><table><thead><tr>${a.table.cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${a.table.rows.map((r) => `<tr>${r.map((c, i) => cell(c, a.table.cols[i] && a.table.cols[i].num)).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    const note = a.note ? `<p class="ai-note">${esc(a.note)}</p>` : '';
    // Findings (alerts, reasons a figure moved): a coloured mark per tone, the line, an optional detail,
    // and — when it has a link — the whole row opens the page behind it.
    const pts = a.points && a.points.length ? `<div class="ai-pts">${a.pointsTitle ? `<div class="ai-pts-h">${esc(a.pointsTitle)}</div>` : ''}<ul>${a.points.map((p) => {
      const body = `<span class="ai-pt-mark" aria-hidden="true"></span><span class="ai-pt-b"><span dir="auto">${esc(p.t)}</span>${p.sub ? `<small dir="auto">${esc(p.sub)}</small>` : ''}</span>`;
      return `<li class="is-${esc(p.tone || 'neutral')}">${p.link ? `<button type="button" class="ai-pt" data-link='${esc(JSON.stringify(p.link))}'>${body}<span class="ai-pt-go">${ICON.chev}</span></button>` : `<div class="ai-pt">${body}</div>`}</li>`;
    }).join('')}</ul></div>` : '';
    const opts = a.options && a.options.length ? `<div class="ai-opts">${a.options.map((o) => `<button type="button" class="ai-chip" data-q="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : '';
    const srcs = a.sources && a.sources.length ? `
      <div class="ai-sources${m.srcOpen ? ' is-open' : ''}">
        <button type="button" class="ai-src-btn" data-srcs="${mi}" aria-expanded="${m.srcOpen ? 'true' : 'false'}">
          <span class="ai-src-stack">${a.sources.slice(0, 3).map(() => `<span>${ICON.doc}</span>`).join('')}</span>
          <span>${esc(sourcesLabel(a.sources.length))}</span>${ICON.chev}
        </button>
        <div class="ai-reason-body"><div><ol class="ai-src-list">${a.sources.map((s) => `
          <li><button type="button" class="ai-src" data-link='${esc(JSON.stringify(s.link || {}))}'>
            <span class="ai-src-n">${s.n}</span>
            <span class="ai-src-t"><span>${esc(s.title)}</span><small>${esc(s.detail || '')}</small></span>
            ${s.link ? `<span class="ai-src-go">${ICON.out}</span>` : ''}
          </button></li>`).join('')}</ol></div></div>
      </div>` : '';
    const understood = a.understood && a.understood.length ? `<span class="ai-und">${esc(T('فهمت:', 'Understood:'))} ${a.understood.map((u) => `<span>${esc(u)}</span>`).join('')}</span>` : '';
    const fix = a.id && (st === 'answered' || st === 'empty' || st === 'notfound')
      ? (m.flagged ? `<span class="ai-flagged">${esc(T('سُجّل للمراجعة', 'Sent for review'))}</span>`
        : `<button type="button" class="ai-fix" data-fix="${mi}">${ICON.flag}${esc(T('ليس هذا ما أقصده', 'Not what I meant'))}</button>`) : '';
    const copy = `<button type="button" class="ai-copy" data-copy="${mi}" title="${esc(T('نسخ الرد', 'Copy the answer'))}">${ICON.copy}<span>${esc(T('نسخ', 'Copy'))}</span></button>`;
    // Wrong side? The employee re-sends it to the external assistant — never moved automatically.
    const other = m.q ? `<button type="button" class="ai-copy ai-resend" data-resend="${mi}" title="${esc(T('إرسال نفس السؤال إلى المساعد الخارجي', 'Send the same question to the external assistant'))}">${ICON.swap}<span>${esc(T('اسأل المساعد الخارجي', 'Ask the external assistant'))}</span></button>` : '';
    const foot = `<div class="ai-foot">${understood}<span class="ai-foot-acts">${copy}${other}${fix}</span></div>`;
    // Reorder plan: product cards grouped by urgency — one look gives what to buy and why.
    const daysTxt = (d) => d == null ? '—' : T(`${d} يوم`, `${d} d`);
    const daysTone = (d) => d == null ? '' : d <= 14 ? ' is-bad' : d <= 30 ? ' is-warn' : ' is-good';
    const plan = a.plan && a.plan.groups && a.plan.groups.length ? `<div class="ai-plan">${a.plan.groups.map((g) => `
      <section class="ai-pg is-${esc(g.tone)}">
        <h4><span class="ai-pg-dot"></span>${esc(g.title)}<span class="ai-pg-n"><bdi>${g.rows.length}</bdi></span></h4>
        <ul>${g.rows.map((r) => `<li class="ai-pc">
          <div class="ai-pc-top">
            <button type="button" class="ai-pc-name" data-link='${esc(JSON.stringify({ kind: 'product', id: r.id }))}'>${esc(r.name)}</button>
            <span class="ai-pc-buy"><small>${esc(T('اشترِ', 'Buy'))}</small><bdi>${r.buy}</bdi></span>
          </div>
          <div class="ai-pc-meta"><bdi>${esc(r.code)}</bdi> · ${esc(T('يوميًا', 'per day'))} <bdi>${r.rate > 0 && r.rate < 0.1 ? '<0.1' : Number(r.rate).toFixed(1)}</bdi> · ${esc(T('صالح', 'ready'))} <bdi>${r.ready}</bdi>${r.incoming ? ` · <span class="ai-pc-inc">${esc(T('وارد', 'incoming'))} <bdi>${r.incoming}</bdi></span>` : ''}${r.late ? ` <span class="ai-pc-tag is-bad">${esc(T('وارد متأخر', 'late incoming'))}</span>` : ''}${r.matched ? ` <span class="ai-pc-tag is-warn" title="${esc(T(`استُلم ${r.matched} بفاتورة غير مربوطة بأمر الشراء`, `${r.matched} received by an invoice not linked to the order`))}">${esc(T('جزء مستلم', 'partly received'))}</span>` : ''}${r.arrived ? ` <span class="ai-pc-tag is-warn">${esc(T('وصل ولم يُسجَّل', 'arrived, not recorded'))}</span>` : ''}</div>
          <div class="ai-pc-stats">
            <span><small>${esc(T('يكفي الآن', 'Lasts now'))}</small><b class="${daysTone(r.now)}">${r.now == null ? esc(T('تحت الحد', 'below min')) : esc(daysTxt(r.now))}</b></span>
            <span><small>${esc(T('بعد الوارد', 'After incoming'))}</small><b class="${r.incoming ? daysTone(r.after) : ''}">${r.incoming ? esc(daysTxt(r.after)) : '—'}</b></span>
            <span><small>${esc(T('العجز المتوقع', 'Shortfall'))}</small><b class="${r.shortfall ? ' is-bad' : ' is-good'}"><bdi>${r.shortfall}</bdi></b></span>
          </div>
          ${r.why ? `<p class="ai-pc-why" dir="auto">${esc(r.why)}</p>` : ''}
          ${r.details && r.details.length ? `<details class="ai-pc-more"><summary>${esc(T('تفاصيل الحساب', 'How it was calculated'))}</summary><dl>${r.details.map((d) => `<div><dt>${esc(d[0])}</dt><dd dir="auto">${esc(d[1])}</dd></div>`).join('')}</dl></details>` : ''}
        </li>`).join('')}</ul>
      </section>`).join('')}</div>` : '';
    const acts = a.actions && a.actions.length ? `<div class="ai-acts">${a.actions.map((x, i) => `<button type="button" class="ai-act" data-act="${mi}:${i}">${ICON.cart}<span>${esc(x.label)}</span></button>`).join('')}</div>` : '';
    return `${reasoning}<div class="ai-card${st === 'denied' ? ' is-denied' : ''}">${lead}${kpis}${plan}${acts}${table}${pts}${note}${opts}</div>${srcs}${foot}`;
  }

  /** While the answer is being read: a live timer and the steps lighting up one after another. */
  function thinkingHtml() {
    const steps = [
      T('فهم السؤال وتحديد الفترة', 'Understanding the question and the period'),
      T('التحقق من صلاحياتك', 'Checking your permissions'),
      T('قراءة التقرير المناسب', 'Reading the matching report'),
    ];
    return `<div class="ai-think" role="status">
      <div class="ai-think-head"><span class="ai-think-orb" aria-hidden="true"></span>
        <span class="ai-shimmer">${esc(T('يفكّر', 'Thinking'))}</span><span class="ai-think-t"><bdi>0.0</bdi> ${esc(T('ث', 's'))}</span></div>
      <ol class="ai-think-steps">${steps.map((s, i) => `<li style="--d:${i * 380}ms"><span class="ai-think-mark" aria-hidden="true"></span>${esc(s)}</li>`).join('')}</ol>
    </div>`;
  }

  const fmtTime = (v) => { try { const d = new Date(v); return isNaN(d) ? '' : d.toLocaleTimeString(ar() ? 'ar-EG-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
  const EXT_NAME = () => T('المساعد الخارجي · Instinct', 'External assistant · Instinct');

  /** A question sent to the external assistant: its mail state while it waits, then the reply. */
  function extHtml(m, mi) {
    const x = m.ext || {};
    // Small and quiet, like the system's own answers: a one-line name tag, no box, no badge.
    const tag = (extra) => `<div class="ai-ext-tag"><span class="ai-ext-av">${ICON.ext}</span><b>Instinct</b>${extra || ''}</div>`;
    const swapIcon = m.q ? `<button type="button" class="ai-ext-swap" data-resend="${mi}" title="${esc(T('اسأل مساعد النظام بدلًا منه', 'Ask the system assistant instead'))}" aria-label="${esc(T('اسأل مساعد النظام بدلًا منه', 'Ask the system assistant instead'))}">${ICON.swap}</button>` : '';
    const swapBtn = m.q ? `<button type="button" class="ai-copy ai-resend" data-resend="${mi}" title="${esc(T('إرسال نفس السؤال إلى مساعد النظام', 'Send the same question to the system assistant'))}">${ICON.swap}<span>${esc(T('اسأل مساعد النظام', 'Ask the system assistant'))}</span></button>` : '';
    if (x.error) {
      return `<div class="ai-msg is-bot is-ext" data-mi="${mi}">${tag()}
        <p class="ai-ext-line is-bad">${esc(x.error)} <button type="button" class="ai-ext-retry" data-ext-retry="${mi}">${esc(T('إعادة المحاولة', 'Try again'))}</button></p></div>`;
    }
    const r = x.reply;
    if (!r) {
      const mail = x.mail || {};
      // One short status after the name; the full wording stays in the tooltip.
      const sub = !x.messageId ? T('جارٍ الإرسال…', 'Sending…')
        : mail.status === 'sent' ? T(`أُرسل ${fmtTime(mail.sentAt)}`, `sent ${fmtTime(mail.sentAt)}`)
        : mail.status === 'failed' ? T('تعذّر الإرسال · إعادة تلقائية', 'Not sent · retrying')
        : mail.status === 'gave-up' ? T('تعذّر الإرسال · أبلغ المدير', 'Not sent · tell the admin')
        : T('جارٍ الإرسال…', 'Sending…');
      const full = mail.status === 'sent' ? T(`أُرسل السؤال بالبريد · ${fmtTime(mail.sentAt)}`, `Question sent by email · ${fmtTime(mail.sentAt)}`)
        : mail.status === 'failed' ? T(`تعذّر إرسال البريد — ستُعاد المحاولة تلقائيًا (المحاولة ${mail.attempts || 1})`, `The email could not be sent — retrying automatically (attempt ${mail.attempts || 1})`)
        : mail.status === 'gave-up' ? T('تعذّر إرسال البريد بعد عدة محاولات. أبلغ مدير النظام.', 'The email could not be sent after several attempts. Tell the system admin.') : sub;
      const tone = mail.status === 'gave-up' ? ' is-bad' : mail.status === 'failed' ? ' is-warn' : '';
      // Admins only (the server sends `failure` to admins): why the send failed and what to fix.
      const f = mail.failure;
      const why = !f ? '' : ({
        'not-configured': T('السبب: حساب البريد غير مُعدّ على الخادم (SMTP_USER / SMTP_PASS). أضِفه في Jenkins باسم soulia-smtp ثم أعد النشر.',
          'Reason: no mail account on the server (SMTP_USER / SMTP_PASS). Add it in Jenkins as soulia-smtp, then redeploy.'),
        auth: T('السبب: رفض خادم البريد كلمة المرور. استخدم «كلمة مرور التطبيقات» من جوجل (16 حرفًا) لا كلمة مرور الحساب، ثم أعد النشر.',
          'Reason: the mail server refused the password. Use a Google App Password (16 characters), not the account password, then redeploy.'),
        network: T('السبب: الخادم لا يصل إلى خادم البريد (المنفذ مغلق أو انتهت المهلة). اطلب من الاستضافة فتح المنفذ 465، أو استخدم خدمة إرسال أخرى.',
          'Reason: the server cannot reach the mail server (port blocked or timed out). Ask the host to open port 465, or use another mail service.'),
      }[f.kind] || T('السبب: خطأ من خادم البريد — التفاصيل أدناه.', 'Reason: an error from the mail server — details below.'));
      const whyHtml = !f ? '' : `<p class="ai-ext-why">${esc(why)}</p><p class="ai-ext-why-detail" dir="ltr">${esc(f.detail || '')}</p>`;
      const status = tone
        ? `<span class="ai-ext-st${tone}" title="${esc(full)}">${esc(sub)}</span>`
        : `<span class="ai-typing" role="status" aria-label="${esc(T('Instinct يكتب الرد', 'Instinct is typing'))}"><i></i><i></i><i></i></span><span class="ai-ext-st" title="${esc(full)}">${esc(sub)}</span>`;
      return `<div class="ai-msg is-bot is-ext" data-mi="${mi}">${tag(status + swapIcon)}${whyHtml}</div>`;
    }
    const tables = (r.tables || []).map((t) => `<div class="ai-ext-tbl">${t.caption ? `<div class="ai-ext-cap" dir="auto">${esc(t.caption)}</div>` : ''}
      <div class="ai-tbl"><table><thead><tr>${t.columns.map((c) => `<th dir="auto">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((row) => `<tr>${row.map((c) => `<td dir="auto">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`).join('');
    // Only http(s) links reach the browser (the server refuses anything else); opened in a new tab.
    const links = r.sourceLinks && r.sourceLinks.length ? `<div class="ai-ext-links"><div class="ai-ext-links-h">${esc(T('المصادر', 'Sources'))}</div><ul>${r.sourceLinks
      .filter((l) => /^https?:\/\//i.test(l.url || ''))
      .map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${ICON.out}<span dir="auto">${esc(l.label || l.url)}</span></a></li>`).join('')}</ul></div>` : '';
    return `<div class="ai-msg is-bot is-ext" data-mi="${mi}">${tag(x.repliedAt ? `<span class="ai-ext-st">· <bdi>${esc(fmtTime(x.repliedAt))}</bdi></span>` : '')}
      <div class="ai-card ai-ext-body">
      ${r.title ? `<h4 class="ai-ext-title" dir="auto">${esc(r.title)}</h4>` : ''}
      ${r.summary ? `<p class="ai-ext-sum" dir="auto">${esc(r.summary)}</p>` : ''}
      ${tables}${links}</div>
      <div class="ai-foot"><span class="ai-foot-acts"><button type="button" class="ai-copy" data-copy="${mi}" title="${esc(T('نسخ الرد', 'Copy the answer'))}">${ICON.copy}<span>${esc(T('نسخ', 'Copy'))}</span></button>${swapBtn}</span></div></div>`;
  }

  function msgHtml(m, mi) {
    if (m.role === 'user') {
      if (m.target === 'external') return `<div class="ai-msg is-user is-ext"><div class="ai-bubble" dir="auto" title="${esc(T('إلى Instinct', 'To Instinct'))}">${esc(m.text)}</div></div>`;
      return `<div class="ai-msg is-user"><div class="ai-bubble" dir="auto">${esc(m.text)}</div></div>`;
    }
    if (m.kind === 'ext') return extHtml(m, mi);
    if (m.pending) return `<div class="ai-msg is-bot">${thinkingHtml()}</div>`;
    if (m.error) return `<div class="ai-msg is-bot"><div class="ai-card is-error"><p class="ai-lead">${esc(m.error)}</p>
      <div class="ai-opts"><button type="button" class="ai-chip" data-retry="${mi}">${esc(T('إعادة المحاولة', 'Try again'))}</button></div></div></div>`;
    if (m.kind === 'po') return `<div class="ai-msg is-bot"><div class="ai-card"><p class="ai-lead">${esc(T('تم إنشاء أمر الشراء ', 'Purchase order created: '))}<b><bdi>${esc(m.po.number)}</bdi></b>${T(` للمورد <b>${esc(m.po.supplier)}</b>: <bdi>${m.po.lines}</bdi> صنف، <bdi>${m.po.qty}</bdi> قطعة.`, ` for <b>${esc(m.po.supplier)}</b>: <bdi>${m.po.lines}</bdi> lines, <bdi>${m.po.qty}</bdi> pieces.`)}</p>
      ${m.po.id ? `<div class="ai-acts"><button type="button" class="ai-act is-quiet" data-open-po="${esc(m.po.id)}">${ICON.out}<span>${esc(T('فتح أمر الشراء', 'Open the purchase order'))}</span></button></div>` : ''}</div></div>`;
    if (m.kind === 'alts') return `<div class="ai-msg is-bot"><div class="ai-card"><p class="ai-lead">${esc(T('شكرًا، سجّلت السؤال لمراجعته وإضافة صيغته. هل تقصد أحد هذه؟', 'Thanks — the question was logged for review. Did you mean one of these?'))}</p>
      <div class="ai-opts">${SUGGESTIONS().map((s) => `<button type="button" class="ai-chip" data-q="${esc(s.q)}">${esc(s.q)}</button>`).join('')}</div></div></div>`;
    return `<div class="ai-msg is-bot" data-mi="${mi}">${answerHtml(m, mi)}</div>`;
  }

  function SUGGESTIONS() {
    const all = [
      { key: 'intake', q: T('مبيعات اليوم', 'Sales today') },
      { key: 'daily', q: T('التقرير اليومي', 'Daily report') },
      { key: 'alerts', q: T('هل توجد مشاكل الآن؟', 'Any problems right now?') },
      { key: 'smartplan', q: T('خطة الشراء الذكية', 'Smart purchase plan') },
      { key: 'reorder', q: T('اقترح كميات الشراء', 'Suggest reorder quantities') },
      { key: 'engine', q: T('تقرير محرك الشراء', 'Purchasing engine report') },
      { key: 'velocity', q: T('أسرع المنتجات بيعًا', 'Fastest-selling products') },
      { key: 'sales', q: T('مبيعات هذا الأسبوع مقارنة بالأسبوع الماضي', 'Sales this week vs last week') },
      { key: 'best', q: T('أفضل شهر في المبيعات', 'Best month for sales') },
      { key: 'profit', q: T('أرباح هذا الشهر', 'Profit this month') },
      { key: 'stock', q: T('المنتجات التي قاربت على النفاد', 'Products running low') },
      { key: 'shopify', q: T('أوردرات شوبيفاي المعلقة', 'Pending Shopify orders') },
      { key: 'followups', q: T('العملاء الذين يحتاجون متابعة هذا الشهر', 'Customers needing follow-up this month') },
      { key: 'supplier', q: T('المستحق للموردين', 'How much we owe suppliers') },
      { key: 'cancel', q: T('أسباب إلغاء الأوردرات هذا الشهر', 'Why orders were cancelled this month') },
    ];
    // Most asked first (server count by topic); topics nobody asked yet keep their place after them.
    const rank = new Map((popular || []).map((t, i) => [t.key, i]));
    return all.map((s, i) => ({ ...s, r: rank.has(s.key) ? rank.get(s.key) : 100 + i })).sort((a, b) => a.r - b.r).slice(0, 8);
  }

  let popular = null, popularAt = 0;
  async function loadPopular() {
    if (Date.now() - popularAt < 5 * 60_000) return;
    popularAt = Date.now();
    try {
      const r = await api('/assistant/popular');
      popular = (r && r.topics) || [];
      if (state.open && !state.msgs.length) renderMsgs(false);
    } catch (_) { popularAt = 0; }
  }

  // ── Morning report (admins): counter on the header button + a card in the empty panel ─────────
  let daily = null, dailyAt = 0;
  const SEEN_KEY = () => 'soulia_ai_daily_seen:' + uid();
  const seenDay = () => { try { return localStorage.getItem(SEEN_KEY()) || ''; } catch (_) { return ''; } };
  function markDailySeen() { if (!daily) return; try { localStorage.setItem(SEEN_KEY(), daily.day); } catch (_) {} syncBadge(); }
  async function loadDaily(force) {
    if (!admin() || (!force && Date.now() - dailyAt < 30 * 60_000)) return;
    dailyAt = Date.now();
    try { daily = await api('/assistant/daily-status'); if (state.open) markDailySeen(); else syncBadge(); if (state.open && !state.msgs.length) renderMsgs(false); } catch (_) { dailyAt = 0; }
  }
  function syncBadge() {
    const b = document.getElementById('ai-hdr-btn');
    if (!b) return;
    let badge = b.querySelector('.ai-hdr-badge');
    const n = daily ? (daily.bad || 0) + (daily.warn || 0) : 0;
    const show = !!daily && n > 0 && seenDay() !== daily.day;
    if (!show) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'ai-hdr-badge'; b.appendChild(badge); }
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.toggle('is-bad', (daily.bad || 0) > 0);
    b.title = T(`مساعد SOULIA · ${n} تنبيه في تقرير اليوم`, `SOULIA Assistant · ${n} alerts in today's report`);
  }
  function dailyCardHtml() {
    if (!admin() || !daily) return '';
    const n = (daily.bad || 0) + (daily.warn || 0);
    const at = (() => { try { return new Date(daily.at).toLocaleTimeString(ar() ? 'ar-EG-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } })();
    return `<button type="button" class="ai-daily${n ? (daily.bad ? ' is-bad' : ' is-warn') : ''}" data-q="${esc(T('التقرير اليومي', 'Daily report'))}" data-daily="1">
      <span class="ai-daily-ic">${ICON.chart}</span>
      <span class="ai-daily-t"><b>${esc(T('تقرير اليوم', "Today's report"))}</b><small>${esc(n ? T(`${n} تنبيه يحتاج انتباهك`, `${n} alerts need your attention`) : T('لا توجد مشكلة واضحة', 'No clear problem'))}${at ? ' · ' + esc(at) : ''}</small></span>
      <span class="ai-daily-go">${ICON.chev}</span></button>`;
  }

  function emptyHtml() {
    return `<div class="ai-empty">
      <div class="ai-empty-mark">${ICON.spark}</div>
      <h3>${esc(T('ماذا تريد أن تعرف اليوم؟', 'What would you like to know today?'))}</h3>
      <p>${esc(T('اكتب سؤالك بكلماتك، وتصلك الإجابة من تقارير SOULIA مع رابط مصدرها.', 'Ask in your own words; the answer comes from the SOULIA reports, with a link to its source.'))}</p>
      ${dailyCardHtml()}
      <div class="ai-sugs-label">${esc(T('الأكثر طلبًا', 'Most asked'))}</div>
      <div class="ai-sugs">${SUGGESTIONS().map((s) => `<button type="button" class="ai-sug" data-q="${esc(s.q)}">${esc(s.q)}</button>`).join('')}</div>
    </div>`;
  }

  function renderMsgs(scrollEnd) {
    const box = document.getElementById('ai-msgs');
    if (!box) return;
    box.innerHTML = state.msgs.length ? state.msgs.map(msgHtml).join('') : emptyHtml();
    if (scrollEnd) box.scrollTop = box.scrollHeight;
  }

  // ── Fast drawing: touch only the messages that changed (a long chat is never redrawn per question) ──
  /** Each message is exactly one child of #ai-msgs; anything else (the empty state) → full draw. */
  const inStep = () => { const box = document.getElementById('ai-msgs'); return !!box && box.children.length === state.msgs.length && !box.querySelector(':scope > .ai-empty'); };
  function appendMsgs(from) {
    const box = document.getElementById('ai-msgs');
    if (!box) return;
    if (box.querySelector(':scope > .ai-empty')) box.innerHTML = '';
    if (box.children.length !== from) { renderMsgs(true); return; }
    box.insertAdjacentHTML('beforeend', state.msgs.slice(from).map((m, i) => msgHtml(m, from + i)).join(''));
    box.scrollTo({ top: box.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
  }
  function replaceMsg(mi, reveal) {
    const box = document.getElementById('ai-msgs');
    if (!box) return;
    if (!inStep()) { renderMsgs(true); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = msgHtml(state.msgs[mi], mi);
    const node = tmp.firstElementChild;
    if (!node) return;
    box.children[mi].replaceWith(node);
    if (reveal && !reduced()) revealAnswer(node);
    // A long answer: bring the question into view so it is read from its start; a short one: to the end.
    const q = box.children[mi - 1];
    const tall = node.offsetHeight > box.clientHeight * 0.7;
    box.scrollTo({ top: tall && q ? Math.max(0, q.offsetTop - 8) : box.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
  }
  /**
   * The answer "streams" in: the lead's words appear one after another, then each block of the card
   * rises in turn. Display only — the text is already complete (copying reads the data, not the DOM).
   */
  function revealAnswer(node) {
    const lead = node.querySelector('.ai-card > .ai-lead');
    let words = 0;
    if (lead) {
      const walker = document.createTreeWalker(lead, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && n.parentElement.closest('button, sup') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (const tn of texts) {
        const parts = tn.nodeValue.split(/(\s+)/);
        if (parts.length < 2 && !parts[0]) continue;
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
          const w = document.createElement('span');
          w.className = 'ai-w';
          w.style.setProperty('--i', String(Math.min(words++, 60)));
          w.textContent = part;
          frag.appendChild(w);
        }
        tn.parentNode.replaceChild(frag, tn);
      }
    }
    node.style.setProperty('--lead', Math.min(words, 60) * 16 + 'ms');
    node.classList.add('is-reveal');
    // Drop the animation hooks once played, so a later re-draw never replays them.
    setTimeout(() => node.classList.remove('is-reveal'), Math.min(words, 60) * 16 + 900);
  }

  function renderReview(data, error) {
    const box = document.getElementById('ai-review');
    if (!box) return;
    if (error) { box.innerHTML = `<div class="ai-rv-empty">${esc(T('تعذّر تحميل السجل.', 'The log could not be loaded.'))} <button type="button" class="ai-chip" data-rv-reload>${esc(T('إعادة المحاولة', 'Try again'))}</button></div>`; return; }
    if (!data) { box.innerHTML = `<div class="ai-rv-skel"><i></i><i></i><i></i></div>`; return; }
    const t = data.totals || {};
    const rate = t.total ? Math.round((t.answered / t.total) * 100) : 0;
    const why = (it) => it.wrong ? [T('فُهم خطأ', 'Misunderstood'), 'bad'] : it.status === 'ambiguous' ? [T('غامض', 'Ambiguous'), 'warn'] : [T('لم يُفهم', 'Not understood'), 'warn'];
    box.innerHTML = `
      <div class="ai-rv-kpis">
        <div><small>${esc(T('أسئلة آخر 30 يومًا', 'Questions, last 30 days'))}</small><b><bdi>${t.total || 0}</bdi></b></div>
        <div><small>${esc(T('أُجيبت', 'Answered'))}</small><b><bdi>${rate}%</bdi></b></div>
        <div><small>${esc(T('قيل إنها خطأ', 'Flagged wrong'))}</small><b><bdi>${t.wrong || 0}</bdi></b></div>
      </div>
      <p class="ai-note">${esc(T('الصيغ التي لم يفهمها المساعد، الأكثر تكرارًا أولًا. تُضاف الصيغ المتكررة إلى المساعد.', 'Wordings the assistant missed, most asked first. Repeated ones get added.'))}</p>
      ${data.items && data.items.length ? `<ul class="ai-rv-list">${data.items.map((it) => {
        const w = why(it);
        const who = (it.users || []).filter(Boolean).slice(0, 3).join(T('، ', ', '));
        return `<li><div class="ai-rv-q" dir="auto">${esc(it.question)}</div>
          <div class="ai-rv-meta"><span class="ai-pill is-${w[1]}">${esc(w[0])}</span><span><bdi>×${it.count}</bdi></span>${who ? `<span>${esc(who)}</span>` : ''}
          <button type="button" class="ai-rv-try" data-q="${esc(it.question)}">${esc(T('جرّبه', 'Try it'))}</button></div></li>`;
      }).join('')}</ul>` : `<div class="ai-rv-empty">${esc(T('لا توجد أسئلة تحتاج مراجعة. كل الأسئلة الأخيرة فُهمت.', 'Nothing to review — every recent question was understood.'))}</div>`}`;
  }

  async function loadReview() {
    renderReview(null);
    try { renderReview(await api('/assistant/review?days=30')); } catch (_) { renderReview(null, true); }
  }

  // ── Panel ─────────────────────────────────────────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById('ai-panel')) return;
    const p = document.createElement('aside');
    p.id = 'ai-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-labelledby', 'ai-title');
    p.hidden = true;
    document.body.appendChild(p);
    const scrim = document.createElement('div');
    scrim.id = 'ai-scrim';
    scrim.hidden = true;
    scrim.addEventListener('click', close);
    document.body.appendChild(scrim);
    p.addEventListener('click', onClick);
    p.addEventListener('keydown', onKey);
    p.addEventListener('mouseover', onHover);
    p.addEventListener('focusin', onHover);
    p.addEventListener('mouseout', onHoverOut);
    p.addEventListener('focusout', onHoverOut);
  }

  function shell() {
    const p = document.getElementById('ai-panel');
    if (!p) return;
    p.setAttribute('dir', ar() ? 'rtl' : 'ltr');
    const isAdm = admin();
    p.innerHTML = `
      <header class="ai-head">
        <div class="ai-brand"><span class="ai-mark">${ICON.spark}</span>
          <div><h2 id="ai-title">${esc(T('مساعد SOULIA', 'SOULIA Assistant'))}</h2><p>${esc(T('يجيب من تقارير النظام نفسها', 'Answers from the system\'s own reports'))}</p></div></div>
        <div class="ai-head-act">
          <button type="button" class="ai-icon-btn" data-new title="${esc(T('محادثة جديدة', 'New conversation'))}" aria-label="${esc(T('محادثة جديدة', 'New conversation'))}">${ICON.plus}</button>
          <button type="button" class="ai-icon-btn" data-close title="${esc(T('إغلاق', 'Close'))}" aria-label="${esc(T('إغلاق', 'Close'))}">${ICON.close}</button>
        </div>
      </header>
      ${isAdm ? `<div class="ai-tabs" role="tablist">
        <button type="button" role="tab" data-view="chat" aria-selected="${state.view === 'chat'}">${esc(T('المحادثة', 'Conversation'))}</button>
        <button type="button" role="tab" data-view="review" aria-selected="${state.view === 'review'}">${esc(T('أسئلة تحتاج مراجعة', 'Needs review'))}</button>
      </div>` : ''}
      <div class="ai-msgs" id="ai-msgs" aria-live="polite" ${state.view === 'chat' ? '' : 'hidden'}></div>
      <div class="ai-review" id="ai-review" ${state.view === 'review' ? '' : 'hidden'}></div>
      <form class="ai-composer${state.target === 'external' ? ' is-external' : ''}${state.busy ? ' is-busy' : ''}" id="ai-form" ${state.view === 'chat' ? '' : 'hidden'}>
        <div class="ai-input-wrap">
          <textarea id="ai-input" rows="1" maxlength="${state.target === 'external' ? 1000 : 300}" placeholder="${esc(state.target === 'external' ? T('اكتب سؤالك للمساعد الخارجي…', 'Write your question for the external assistant…') : T('اسأل عن المبيعات أو المخزون أو أوردر…', 'Ask about sales, stock or an order…'))}" aria-label="${esc(T('اكتب سؤالك', 'Type your question'))}"></textarea>
          <div class="ai-tools">
            ${modelPickerHtml()}
            <button type="submit" class="ai-send" aria-label="${esc(state.target === 'external' ? T('إرسال إلى المساعد الخارجي', 'Send to the external assistant') : T('إرسال', 'Send'))}">${ICON.send}<span class="ai-send-spin" aria-hidden="true"></span></button>
          </div>
        </div>
        <p class="ai-hint">${esc(state.target === 'external'
          ? T('يُرسل سؤالك إلى Instinct، ويظهر رده هنا عند وصوله.', 'Sent to Instinct; the reply shows here when it arrives.')
          : T('Enter للإرسال · Shift+Enter لسطر جديد · Ctrl+/ لفتح المساعد', 'Enter to send · Shift+Enter for a new line · Ctrl+/ to open'))}</p>
      </form>
      <div class="ai-pop" id="ai-pop" role="tooltip" hidden></div>`;
    const form = p.querySelector('#ai-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); const i = p.querySelector('#ai-input'); ask(i.value); });
    const input = p.querySelector('#ai-input');
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); ask(input.value); }
    });
    renderMsgs(true);
    p.querySelector('#ai-msgs')?.addEventListener('scroll', hidePop, { passive: true });
    if (state.view === 'review') loadReview();
  }

  function autosize() { const i = document.getElementById('ai-input'); if (!i) return; i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 132) + 'px'; }

  let lastFocus = null;
  function open(q) {
    buildPanel();
    const p = document.getElementById('ai-panel');
    if (!state.open) {
      lastFocus = document.activeElement;
      if (!state.msgs.length) restore();
      // The system assistant is the default each time the panel opens.
      state.target = 'system';
      state.open = true;
      bindSocket();
      syncExternal();
      armExternalPoll();
      shell();
      p.hidden = false;
      document.getElementById('ai-scrim').hidden = false;
      requestAnimationFrame(() => p.classList.add('is-open'));
      loadPopular();
      loadDaily(false);
      // Opening the panel shows today's report card, so the header counter has been seen.
      markDailySeen();
      document.body.classList.add('ai-open');
      syncBtn();
    }
    if (q) ask(q);
    else setTimeout(() => document.getElementById('ai-input')?.focus(), reduced() ? 0 : 180);
  }

  function close() {
    const p = document.getElementById('ai-panel');
    if (!p || !state.open) return;
    state.open = false;
    hidePop();
    p.classList.remove('is-open');
    document.body.classList.remove('ai-open');
    document.getElementById('ai-scrim').hidden = true;
    setTimeout(() => { if (!state.open) p.hidden = true; }, reduced() ? 0 : 220);
    syncBtn();
    try { (lastFocus && document.contains(lastFocus) ? lastFocus : document.getElementById('ai-hdr-btn'))?.focus(); } catch (_) {}
  }
  const toggle = () => (state.open ? close() : open());

  // ── Who answers: a small picker inside the input box (like a model picker) ─────────────────────
  const MODELS = () => [
    { key: 'system', icon: ICON.spark, name: 'SOULIA', desc: T('إجابة فورية من تقارير النظام', 'Instant answers from the system reports') },
    { key: 'external', icon: ICON.ext, name: 'Instinct', desc: T('مساعد خارجي — يصل رده بعد قليل', 'External assistant — replies a little later') },
  ];
  function modelPickerHtml() {
    const cur = MODELS().find((m) => m.key === state.target) || MODELS()[0];
    return `<div class="ai-model">
      <button type="button" class="ai-model-btn" data-model-menu aria-haspopup="menu" aria-expanded="false" title="${esc(T('من يجيب عن سؤالك؟', 'Who answers your question?'))}">
        <span class="ai-model-ic">${cur.icon}</span><span class="ai-model-name">${esc(cur.name)}</span>${ICON.chev}
      </button>
      <div class="ai-model-menu" role="menu" aria-label="${esc(T('من يجيب عن سؤالك؟', 'Who answers your question?'))}" hidden>
        ${MODELS().map((m) => `<button type="button" role="menuitemradio" class="ai-model-opt is-${m.key}" data-target="${m.key}" aria-checked="${m.key === state.target}">
          <span class="ai-model-ic">${m.icon}</span>
          <span class="ai-model-t"><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></span>
          <span class="ai-model-ok">${ICON.check}</span>
        </button>`).join('')}
      </div>
    </div>`;
  }
  function modelMenu(openIt) {
    const p = document.getElementById('ai-panel');
    const menu = p?.querySelector('.ai-model-menu');
    const btn = p?.querySelector('[data-model-menu]');
    if (!menu || !btn) return;
    const show = openIt === undefined ? menu.hidden : !!openIt;
    menu.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show) (menu.querySelector('[aria-checked="true"]') || menu.querySelector('[data-target]'))?.focus();
  }
  const modelMenuOpen = () => { const m = document.querySelector('#ai-panel .ai-model-menu'); return !!m && !m.hidden; };

  // ── Asking ────────────────────────────────────────────────────────────────────────────────────
  /** Switches who answers the next question, in place (what is typed stays). */
  function setTarget(t) {
    state.target = t === 'external' ? 'external' : 'system';
    const p = document.getElementById('ai-panel');
    if (!p) return;
    const ext = state.target === 'external';
    p.querySelector('#ai-form')?.classList.toggle('is-external', ext);
    p.querySelectorAll('[data-target]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.target === state.target)));
    const cur = MODELS().find((m) => m.key === state.target);
    const mb = p.querySelector('[data-model-menu]');
    if (mb && cur) { mb.querySelector('.ai-model-ic').innerHTML = cur.icon; mb.querySelector('.ai-model-name').textContent = cur.name; }
    modelMenu(false);
    const i = p.querySelector('#ai-input');
    if (i) {
      i.maxLength = ext ? 1000 : 300;
      i.placeholder = ext ? T('اكتب سؤالك للمساعد الخارجي…', 'Write your question for the external assistant…') : T('اسأل عن المبيعات أو المخزون أو أوردر…', 'Ask about sales, stock or an order…');
      i.focus();
    }
    const s = p.querySelector('.ai-send');
    if (s) s.setAttribute('aria-label', ext ? T('إرسال إلى المساعد الخارجي', 'Send to the external assistant') : T('إرسال', 'Send'));
    const h = p.querySelector('.ai-hint');
    if (h) h.textContent = ext
      ? T('يُرسل سؤالك إلى Instinct، ويظهر رده هنا عند وصوله.', 'Sent to Instinct; the reply shows here when it arrives.')
      : T('Enter للإرسال · Shift+Enter لسطر جديد · Ctrl+/ لفتح المساعد', 'Enter to send · Shift+Enter for a new line · Ctrl+/ to open');
  }

  /** `target` is fixed when the question is sent and kept on the message; the default is the toggle. */
  async function ask(text, target) {
    text = String(text || '').trim();
    if (!text || state.busy) return;
    if ((target || state.target) === 'external') return askExternal(text);
    if (state.view !== 'chat') { state.view = 'chat'; shell(); }
    const input = document.getElementById('ai-input');
    if (input) { input.value = ''; autosize(); }
    const from = state.msgs.length;
    state.msgs.push({ role: 'user', text, target: 'system' });
    const bot = { role: 'bot', pending: true, q: text, target: 'system' };
    state.msgs.push(bot);
    setBusy(true);
    appendMsgs(from);
    const t0 = performance.now();
    // The thinking line counts the seconds while the answer is read.
    const tick = setInterval(() => {
      const el = document.querySelector(`#ai-msgs > :nth-child(${state.msgs.indexOf(bot) + 1}) .ai-think-t bdi`);
      if (el) el.textContent = ((performance.now() - t0) / 1000).toFixed(1);
    }, 100);
    try {
      const a = await api('/assistant/ask', { method: 'POST', body: JSON.stringify({ question: text, lang: ar() ? 'ar' : 'en', target: 'system', chatId: chatId() }) });
      // A very fast answer still shows "thinking" for a beat — an instant swap reads as a glitch.
      const wait = reduced() ? 0 : Math.max(0, 260 - (performance.now() - t0));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      bot.pending = false;
      bot.a = a;
      if (a && a.intent === 'daily') markDailySeen();
      bot.reasonOpen = false; // "Thought for N s" — folded; the steps are one click away
    } catch (e) {
      bot.pending = false;
      bot.error = (e && e.message) || T('تعذّر الاتصال بالخادم.', 'Could not reach the server.');
    } finally {
      clearInterval(tick);
      setBusy(false);
      const mi = state.msgs.indexOf(bot);
      if (mi >= 0) replaceMsg(mi, !bot.error);
      save();
      document.getElementById('ai-input')?.focus();
    }
  }

  /** Busy: the send button turns into a spinner and the composer shows it is working. */
  function setBusy(on) {
    state.busy = !!on;
    document.getElementById('ai-form')?.classList.toggle('is-busy', state.busy);
  }

  // ── External assistant (Instinct) ─────────────────────────────────────────────────────────────
  async function askExternal(text) {
    if (state.view !== 'chat') { state.view = 'chat'; shell(); }
    const input = document.getElementById('ai-input');
    if (input) { input.value = ''; autosize(); }
    state.msgs.push({ role: 'user', text, target: 'external' });
    // One key per question: a retry after a lost reply never sends a second email.
    const bot = { role: 'bot', kind: 'ext', target: 'external', q: text, key: 'rk_' + rand(16), ext: {} };
    state.msgs.push(bot);
    renderMsgs(true);
    save();
    await sendExternal(bot);
  }
  async function sendExternal(bot) {
    setBusy(true);
    try {
      const r = await api('/assistant/external', { method: 'POST', body: JSON.stringify({ target: 'external', chatId: chatId(), question: bot.q, requestKey: bot.key }) });
      bot.ext = r || {};
    } catch (e) {
      bot.ext = { error: (e && e.message) || T('تعذّر الاتصال بالخادم.', 'Could not reach the server.') };
    } finally {
      setBusy(false);
      renderMsgs(true);
      save();
      armExternalPoll();
      document.getElementById('ai-input')?.focus();
    }
  }

  const waitingExt = () => state.msgs.filter((m) => m.kind === 'ext' && m.ext && m.ext.messageId && !m.ext.reply);
  let extPolling = false, extAgain = false;
  /** Reads the asker's waiting external questions; draws any reply that arrived. */
  async function syncExternal() {
    // A reply event that lands while a read is in flight runs one more read right after it.
    if (extPolling) { extAgain = true; return; }
    const list = waitingExt();
    if (!list.length) return;
    extPolling = true;
    try {
      const r = await api('/assistant/external?ids=' + encodeURIComponent(list.map((m) => m.ext.messageId).join(',')));
      let answered = 0, changed = false;
      for (const it of (r && r.items) || []) {
        const m = list.find((x) => x.ext.messageId === it.messageId);
        if (!m) continue;
        if (it.reply && !m.ext.reply) answered++;
        if (JSON.stringify(m.ext) !== JSON.stringify(it)) { m.ext = it; changed = true; }
      }
      if (changed) {
        save();
        if (state.open) {
          const box = document.getElementById('ai-msgs');
          const atEnd = box && box.scrollHeight - box.scrollTop - box.clientHeight < 40;
          renderMsgs(!!(answered && atEnd));
        }
      }
      if (answered && !state.open && typeof toast === 'function') toast(T('وصل رد المساعد الخارجي — افتح مساعد SOULIA', 'The external assistant replied — open the SOULIA Assistant'));
    } catch (_) { /* next tick */ } finally {
      extPolling = false;
      if (extAgain) { extAgain = false; syncExternal(); }
    }
  }
  let extTimer = null;
  function armExternalPoll() {
    if (extTimer || !waitingExt().length) return;
    extTimer = setInterval(() => { if (!waitingExt().length) { clearInterval(extTimer); extTimer = null; return; } syncExternal(); }, 20_000);
  }
  function bindSocket() {
    if (typeof socket === 'undefined' || !socket || socket.__aiExtBound) return;
    socket.__aiExtBound = true;
    socket.on('assistant:external-reply', () => { syncExternal(); });
  }

  function foldReason(mi, openIt) {
    const el = document.querySelector(`#ai-msgs .ai-msg[data-mi="${mi}"] .ai-reason`);
    if (!el) return;
    el.classList.toggle('is-open', openIt);
    el.querySelector('.ai-reason-btn')?.setAttribute('aria-expanded', openIt ? 'true' : 'false');
  }

  async function flag(mi) {
    const m = state.msgs[mi];
    if (!m || !m.a || !m.a.id || m.flagged) return;
    m.flagged = true;
    state.msgs.push({ role: 'bot', kind: 'alts' });
    renderMsgs(true);
    save();
    try { await api(`/assistant/${encodeURIComponent(m.a.id)}/wrong`, { method: 'POST', body: '{}' }); } catch (_) { /* the alternatives still help */ }
  }

  // ── Purchase order from the reorder suggestions ───────────────────────────────────────────────
  // «إنشاء أمر شراء» → a quick list of the suppliers the suggestions come from (products · pieces each)
  // → the dialog opens on that supplier's products. Other suggested products stay one click away,
  // unticked. Same create route as the demand analysis (POST /demand-planning/create-purchase-order).
  async function poContext(act) {
    if (typeof hasPerm === 'function' && !hasPerm('suppliers') && !admin()) { toast(T('تحتاج صلاحية الموردين لإنشاء أمر شراء.', 'You need the suppliers permission to create a purchase order.'), true); return null; }
    try { if (typeof suppliers !== 'undefined' && !suppliers.length) suppliers = await api('/suppliers'); } catch (_) {}
    const list = (typeof suppliers !== 'undefined' && Array.isArray(suppliers)) ? suppliers : [];
    if (!list.length) { toast(T('لا يوجد موردون مسجلون.', 'No suppliers registered.'), true); return null; }
    // A product often stores its primary supplier by NAME only (no id) — resolve it against the list.
    const nm = (x) => String(x || '').trim().toLowerCase();
    const byName = new Map(list.map((x) => [nm(x.name), String(x._id)]));
    const lines = (act.lines || []).map((l, i) => ({ ...l, i,
      sid: (l.supplierId && list.some((x) => String(x._id) === l.supplierId)) ? l.supplierId : (byName.get(nm(l.supplier)) || '') }));
    return { list, lines };
  }

  function closePoMenu() { document.getElementById('ai-po-menu')?.remove(); document.removeEventListener('mousedown', poMenuOutside, true); }
  function poMenuOutside(e) { const m = document.getElementById('ai-po-menu'); if (m && !m.contains(e.target) && !e.target.closest('[data-act]')) closePoMenu(); }

  async function openPoMenu(act, btn) {
    if (document.getElementById('ai-po-menu')) { closePoMenu(); return; }
    const ctx = await poContext(act);
    if (!ctx) return;
    const { list, lines } = ctx;
    const groups = new Map();
    for (const l of lines) {
      const key = l.sid || '';
      const g = groups.get(key) || { sid: key, name: key ? (list.find((x) => String(x._id) === key)?.name || l.supplier) : '', n: 0, qty: 0 };
      g.n++; g.qty += Number(l.qty) || 0;
      groups.set(key, g);
    }
    const named = [...groups.values()].filter((g) => g.sid).sort((a, b) => b.n - a.n || b.qty - a.qty);
    const none = groups.get('');
    const row = (val, title, g) => `<button type="button" role="menuitem" class="ai-pom-row" data-po-sup="${esc(val)}">
      <span class="ai-pom-name">${esc(title)}</span>${g ? `<span class="ai-pom-meta"><bdi>${g.n}</bdi> ${esc(T('منتج', 'products'))} · <bdi>${g.qty}</bdi> ${esc(T('قطعة', 'pcs'))}</span>` : ''}</button>`;
    const menu = document.createElement('div');
    menu.id = 'ai-po-menu';
    menu.className = 'ai-pom';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="ai-pom-h">${esc(T('اختر المورد', 'Pick the supplier'))}</div>
      ${named.map((g) => row(g.sid, g.name, g)).join('')}
      ${none ? row('__none', T('منتجات بدون مورد أساسي', 'Products with no primary supplier'), none) : ''}
      <div class="ai-pom-sep"></div>${row('__other', T('مورد آخر…', 'Another supplier…'), null)}`;
    const panel = document.getElementById('ai-panel');
    panel.appendChild(menu);
    const pr = panel.getBoundingClientRect(), br = btn.getBoundingClientRect();
    const w = Math.min(300, pr.width - 24);
    menu.style.width = w + 'px';
    const rtl = panel.getAttribute('dir') === 'rtl';
    let left = rtl ? br.right - pr.left - w : br.left - pr.left;
    left = Math.max(12, Math.min(left, pr.width - w - 12));
    menu.style.left = left + 'px';
    const h = menu.offsetHeight;
    let top = br.bottom - pr.top + 6;
    if (top + h > pr.height - 8) top = Math.max(8, br.top - pr.top - h - 6);
    menu.style.top = top + 'px';
    menu.querySelector('[data-po-sup]')?.focus();
    menu.addEventListener('click', (e) => { const b = e.target.closest('[data-po-sup]'); if (!b) return; closePoMenu(); openPoDialog(act, ctx, b.dataset.poSup); });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[data-po-sup]')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePoMenu(); btn.focus(); }
    });
    setTimeout(() => document.addEventListener('mousedown', poMenuOutside, true), 0);
  }

  function openPoDialog(act, ctx, choice) {
    if (typeof openModal !== 'function' || !ctx) return;
    const { list, lines } = ctx;
    const seePrice = lines.some((l) => l.unitPrice > 0);
    const startSid = choice && choice !== '__none' && choice !== '__other' ? choice : '';
    // What is ticked and the quantities survive a change of supplier in the dialog.
    const checked = new Set();
    const qtys = new Map(lines.map((l) => [l.i, Math.max(1, Number(l.qty) || 1)]));
    const isMain = (l, sid) => (choice === '__none' && !sid ? !l.sid : (!!sid && l.sid === sid));
    lines.forEach((l) => { if (choice !== '__other' && isMain(l, startSid)) checked.add(l.i); });
    let showOthers = choice === '__other';
    const lineHtml = (l) => `<label class="ai-po-line">
      <input type="checkbox" class="ai-po-chk" data-i="${l.i}" ${checked.has(l.i) ? 'checked' : ''}>
      <span class="ai-po-name"><b>${esc(l.name)}</b><small><bdi>${esc(l.sku)}</bdi> · ${l.supplier ? esc(l.supplier) : esc(T('بدون مورد أساسي', 'no primary supplier'))} · ${esc(T('صالح', 'ready'))} <bdi>${Number(l.ready) || 0}</bdi>${l.incoming ? ` · <span class="ai-po-inc">${esc(T('وارد', 'incoming'))} <bdi>${l.incoming}</bdi></span>` : ''}</small></span>
      <input type="number" class="ai-po-qty" data-i="${l.i}" min="1" step="1" value="${qtys.get(l.i)}" aria-label="${esc(T('الكمية', 'Quantity'))}">
    </label>`;
    openModal(`
      <div class="ai-po" dir="${ar() ? 'rtl' : 'ltr'}">
        <h3>${esc(T('إنشاء أمر شراء', 'Create purchase order'))}</h3>
        <p class="ai-po-intro">${esc(T('راجع الكميات. لا يُنشأ شيء قبل الضغط على «إنشاء أمر الشراء».', 'Review the quantities. Nothing is created until you press «Create purchase order».'))}</p>
        <label class="ai-po-lbl" for="ai-po-supplier">${esc(T('المورد', 'Supplier'))}</label>
        <select id="ai-po-supplier">
          <option value="">${esc(T('اختر المورد', 'Pick a supplier'))}</option>
          ${list.map((x) => `<option value="${esc(x._id)}" ${String(x._id) === startSid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select>
        <div id="ai-po-body"></div>
        <div class="ai-po-row">
          <div><label class="ai-po-lbl" for="ai-po-date">${esc(T('تاريخ الاستلام المتوقع', 'Expected delivery'))}</label><input type="date" id="ai-po-date"></div>
        </div>
        <label class="ai-po-lbl" for="ai-po-notes">${esc(T('ملاحظات', 'Notes'))}</label>
        <textarea id="ai-po-notes" rows="2">${esc(T('من اقتراحات مساعد SOULIA (سرعة البيع في آخر 30 يومًا).', 'From SOULIA Assistant suggestions (sales speed over the last 30 days).'))}</textarea>
        <div class="ai-po-foot">
          <span id="ai-po-sum" class="ai-po-sum"></span>
          <div class="ai-po-btns">
            <button type="button" class="btn btn-outline btn-sm" id="ai-po-cancel">${esc(T('إلغاء', 'Cancel'))}</button>
            <button type="button" class="btn btn-primary btn-sm" id="ai-po-ok">${esc(T('إنشاء أمر الشراء', 'Create purchase order'))}</button>
          </div>
        </div>
      </div>`, 'max-width:620px;width:calc(100% - 28px);padding:20px');
    const root = document.querySelector('.ai-po');
    if (!root) return;
    const sel = root.querySelector('#ai-po-supplier');
    const draw = () => {
      const sid = sel.value;
      const main = choice === '__other' ? [] : lines.filter((l) => isMain(l, sid));
      const others = lines.filter((l) => !main.includes(l));
      const supName = list.find((x) => String(x._id) === sid)?.name || '';
      const mainTitle = choice === '__none' && !sid ? T('منتجات بدون مورد أساسي', 'Products with no primary supplier')
        : T(`منتجات ${supName} المقترحة`, `Suggested products of ${supName}`);
      root.querySelector('#ai-po-body').innerHTML = `
        ${main.length ? `<div class="ai-po-sec">${esc(mainTitle)} <bdi>(${main.length})</bdi></div><div class="ai-po-lines">${main.map(lineHtml).join('')}</div>`
          : (choice !== '__other' ? `<p class="ai-po-hint">${esc(sid ? T('لا توجد منتجات مقترحة هذا المورد موردها الأساسي. أضف من القائمة أدناه.', 'No suggested product has this supplier as primary. Add from the list below.') : T('اختر المورد أولًا.', 'Pick the supplier first.'))}</p>` : '')}
        ${others.length ? `<button type="button" class="ai-po-more" id="ai-po-more" aria-expanded="${showOthers}">${esc(choice === '__other' ? T('المنتجات المقترحة', 'Suggested products') : T('أصناف مقترحة أخرى', 'Other suggested products'))} <bdi>(${others.length})</bdi>${ICON.chev}</button>
          <div class="ai-po-lines" ${showOthers ? '' : 'hidden'}>${others.map(lineHtml).join('')}</div>` : ''}`;
      root.querySelector('#ai-po-more')?.addEventListener('click', () => { showOthers = !showOthers; draw(); });
      sum();
    };
    const chosen = () => lines.filter((l) => checked.has(l.i)).map((l) => ({ ...l, qty: qtys.get(l.i) }));
    const sum = () => {
      const c = chosen();
      const qty = c.reduce((x, l) => x + l.qty, 0);
      const cost = c.reduce((x, l) => x + l.qty * (l.unitPrice || 0), 0);
      root.querySelector('#ai-po-sum').textContent = T(`${c.length} صنف · ${qty} قطعة`, `${c.length} lines · ${qty} pieces`) + (seePrice && cost ? T(` · تقديريًا ${Math.round(cost).toLocaleString('en-US')} جنيه`, ` · est. EGP ${Math.round(cost).toLocaleString('en-US')}`) : '');
      root.querySelector('#ai-po-ok').disabled = !c.length;
    };
    sel.addEventListener('change', () => {
      // A newly chosen supplier brings its own products in ticked; anything ticked by hand stays ticked.
      if (choice === '__other') choice = '';
      lines.forEach((l) => { if (sel.value && l.sid === sel.value) checked.add(l.i); });
      draw();
    });
    root.addEventListener('change', (e) => {
      const c = e.target.closest('.ai-po-chk');
      if (c) { if (c.checked) checked.add(+c.dataset.i); else checked.delete(+c.dataset.i); sum(); }
    });
    root.addEventListener('input', (e) => {
      const q = e.target.closest('.ai-po-qty');
      if (q) { qtys.set(+q.dataset.i, Math.max(1, Math.round(Number(q.value) || 0))); sum(); }
    });
    root.querySelector('#ai-po-cancel').addEventListener('click', () => closeModal());
    root.querySelector('#ai-po-ok').addEventListener('click', async () => {
      const sup = list.find((x) => String(x._id) === sel.value);
      if (!sup) { toast(T('اختر المورد أولًا.', 'Pick the supplier first.'), true); sel.focus(); return; }
      const c = chosen();
      if (!c.length) { toast(T('حدد صنفًا واحدًا على الأقل.', 'Tick at least one line.'), true); return; }
      const qty = c.reduce((x, l) => x + l.qty, 0);
      const ok = typeof showConfirm === 'function' ? await showConfirm(T(`سيُنشأ أمر شراء للمورد ${sup.name}.`, `A purchase order will be created for ${sup.name}.`), {
        title: T('تأكيد إنشاء أمر الشراء', 'Confirm the purchase order'), confirmLabel: T('إنشاء', 'Create'),
        rows: [[T('المورد', 'Supplier'), sup.name], [T('الأصناف', 'Lines'), String(c.length)], [T('الكمية', 'Quantity'), String(qty)]],
      }) : true;
      if (!ok) return;
      const btn = root.querySelector('#ai-po-ok');
      btn.disabled = true; btn.textContent = T('جارٍ الإنشاء…', 'Creating…');
      try {
        const res = await api('/demand-planning/create-purchase-order', {
          method: 'POST',
          body: JSON.stringify({
            supplierId: String(sup._id), supplierName: sup.name,
            expectedDeliveryDate: root.querySelector('#ai-po-date').value || '',
            notes: root.querySelector('#ai-po-notes').value || '',
            lines: c.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, ...(l.unitPrice > 0 ? { unitPrice: l.unitPrice } : {}) })),
            by: (typeof currentUser !== 'undefined' && (currentUser?.name || currentUser?.username)) || '',
            byUsername: (typeof currentUser !== 'undefined' && currentUser?.username) || '',
            transactionIds: [], note: T('من اقتراحات مساعد SOULIA', 'From SOULIA Assistant suggestions'),
          }),
        });
        try { if (typeof purchaseOrders !== 'undefined') purchaseOrders = await api('/purchase-orders'); } catch (_) {}
        closeModal();
        const po = res && res.po || {};
        toast(T(`تم إنشاء أمر الشراء ${po.poNumber || ''}`, `Purchase order ${po.poNumber || ''} created`));
        state.msgs.push({ role: 'bot', kind: 'po', po: { id: String(po._id || ''), number: po.poNumber || '', supplier: sup.name, lines: c.length, qty } });
        renderMsgs(true); save();
      } catch (e) {
        toast(T('تعذّر إنشاء أمر الشراء: ', 'Could not create the purchase order: ') + ((e && e.message) || ''), true);
        btn.disabled = false; btn.textContent = T('إنشاء أمر الشراء', 'Create purchase order');
      }
    });
    draw();
  }

  // ── Links ─────────────────────────────────────────────────────────────────────────────────────
  /** Runs `fn` once `ready()` is true — a page's own script or render may still be on its way. */
  function when(ready, fn, tries = 40) {
    try { if (ready()) { fn(); return; } } catch (_) {}
    if (tries > 0) setTimeout(() => when(ready, fn, tries - 1), 100);
  }
  const onPage = (p) => typeof currentPage !== 'undefined' && currentPage === p;
  function navTo(page) { if (!onPage(page) && typeof navigateTo === 'function') navigateTo(page); }

  /** Opens the source in the state the answer used: same report dates and tab, same Shopify
   *  period, the inventory filter, the exact order. */
  function go(link) {
    if (!link || !link.kind) return;
    hidePop();
    try {
      if (link.kind === 'order' && link.id && typeof openOrderView === 'function') openOrderView(link.id);
      else if (link.kind === 'supplier' && link.id && typeof openSupplierProfile === 'function') openSupplierProfile(link.id);
      else if (link.kind === 'product' && link.id && typeof openProductPage === 'function') openProductPage(link.id);
      else if (link.kind === 'po' && link.id) {
        const show = () => { try { if (typeof openPoDetailModal === 'function') openPoDetailModal(link.id); } catch (_) {} };
        if (typeof purchaseOrders !== 'undefined' && purchaseOrders.some((x) => x._id === link.id)) show();
        else api('/purchase-orders').then((r) => { if (typeof purchaseOrders !== 'undefined' && Array.isArray(r)) purchaseOrders = r; show(); }).catch(() => {});
      } else if (link.kind === 'shopify' && link.id) {
        const known = typeof _spOrderById === 'function' && _spOrderById(link.id);
        if (!known) navTo('shopify-orders');
        when(() => typeof openSpOrderPeek === 'function' && (known || onPage('shopify-orders')), () => openSpOrderPeek(link.id));
      } else if (link.kind === 'page' && link.page === 'reports') {
        const f = document.getElementById('rep-from'), t = document.getElementById('rep-to');
        if (link.from && f) f.value = link.from;
        if (link.to && t) t.value = link.to;
        if (typeof _clearRepPresetBtns === 'function') _clearRepPresetBtns();
        const tab = link.tab || 'kpis';
        const showTab = () => {
          const btn = document.querySelector(`#page-reports .rep-sec-tab[data-rep-tab="${tab}"]`);
          if (btn && typeof switchReportTab === 'function' && !btn.classList.contains('active')) switchReportTab(tab, btn);
        };
        if (onPage('reports')) { showTab(); if (typeof loadReports === 'function') loadReports(); }
        else { navTo('reports'); when(() => onPage('reports'), showTab); }
      } else if (link.kind === 'page' && link.page === 'shopify-orders') {
        navTo('shopify-orders');
        if (link.period) when(() => onPage('shopify-orders') && typeof _spkSetPeriod === 'function', () => _spkSetPeriod(link.period));
      } else if (link.kind === 'page' && link.page === 'inventory') {
        navTo('inventory');
        // Wait for the inventory itself, not just the page: its first render resets the list.
        if (link.filter) when(() => onPage('inventory') && typeof setInvFilter === 'function' && typeof inventoryCache !== 'undefined' && inventoryCache.length > 0
          && document.querySelector('#inv-table-body tr, #inv-tbody tr, #page-inventory tbody tr'), () => setTimeout(() => setInvFilter(link.filter), 150), 150);
      } else if (link.kind === 'page' && link.page) navTo(link.page);
    } catch (_) {}
    if (window.matchMedia('(max-width: 760px)').matches) close();
  }

  // ── Citation preview ──────────────────────────────────────────────────────────────────────────
  let popFor = null;
  function onHover(e) {
    const c = e.target.closest && e.target.closest('.ai-cite');
    if (!c || c === popFor) return;
    const m = state.msgs[+c.dataset.mi];
    const s = m && m.a && (m.a.sources || []).find((x) => String(x.n) === c.dataset.cite);
    if (!s) return;
    popFor = c;
    const pop = document.getElementById('ai-pop');
    pop.innerHTML = `<span class="ai-pop-k">${ICON.doc}${esc(T('المصدر', 'Source'))} ${s.n}</span><b>${esc(s.title)}</b><small>${esc(s.detail || '')}</small>${s.link ? `<span class="ai-pop-go">${esc(T('اضغط لفتح الصفحة', 'Click to open the page'))}</span>` : ''}`;
    pop.hidden = false;
    const panel = document.getElementById('ai-panel').getBoundingClientRect();
    const r = c.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = r.left + r.width / 2 - w / 2 - panel.left;
    left = Math.max(10, Math.min(left, panel.width - w - 10));
    let top = r.top - panel.top - h - 8;
    if (top < 60) top = r.bottom - panel.top + 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  function onHoverOut(e) {
    const c = e.target.closest && e.target.closest('.ai-cite');
    if (c && (!e.relatedTarget || !c.contains(e.relatedTarget))) hidePop();
  }
  function hidePop() { popFor = null; const p = document.getElementById('ai-pop'); if (p) p.hidden = true; }

  // ── Events ────────────────────────────────────────────────────────────────────────────────────
  function onClick(e) {
    const t = e.target;
    const q = t.closest('[data-q]');
    // Suggestions and options are the system assistant's own questions, whatever the toggle says.
    if (q) { if (q.dataset.daily) markDailySeen(); ask(q.dataset.q, 'system'); return; }
    if (t.closest('[data-close]')) { close(); return; }
    if (t.closest('[data-new]')) { state.msgs = []; state.chatId = newChatId(); state.target = 'system'; save(); state.view = 'chat'; shell(); document.getElementById('ai-input')?.focus(); return; }
    if (t.closest('[data-model-menu]')) { modelMenu(); return; }
    const tg = t.closest('[data-target]');
    if (tg) { setTarget(tg.dataset.target); return; }
    if (modelMenuOpen() && !t.closest('.ai-model')) modelMenu(false);
    // Re-send the same question to the other side — the employee's choice, never automatic.
    const rs = t.closest('[data-resend]');
    if (rs) { const m = state.msgs[+rs.dataset.resend]; if (m && m.q && !state.busy) ask(m.q, m.kind === 'ext' ? 'system' : 'external'); return; }
    const xr = t.closest('[data-ext-retry]');
    if (xr) { const m = state.msgs[+xr.dataset.extRetry]; if (m && m.kind === 'ext' && !state.busy) { m.ext = {}; renderMsgs(true); sendExternal(m); } return; }
    const v = t.closest('[data-view]');
    if (v) { state.view = v.dataset.view; shell(); return; }
    if (t.closest('[data-rv-reload]')) { loadReview(); return; }
    const r = t.closest('[data-reason]');
    if (r) { const m = state.msgs[+r.dataset.reason]; if (m) { m.autoFold = false; m.reasonOpen = !m.reasonOpen; foldReason(+r.dataset.reason, m.reasonOpen); save(); } return; }
    const s = t.closest('[data-srcs]');
    if (s) { const m = state.msgs[+s.dataset.srcs]; if (m) { m.srcOpen = !m.srcOpen; s.closest('.ai-sources').classList.toggle('is-open', m.srcOpen); s.setAttribute('aria-expanded', m.srcOpen ? 'true' : 'false'); save(); } return; }
    const ac = t.closest('[data-act]');
    if (ac) { const [mi, i] = ac.dataset.act.split(':').map(Number); const act = state.msgs[mi]?.a?.actions?.[i]; if (act && act.kind === 'createPo') openPoMenu(act, ac); return; }
    const op = t.closest('[data-open-po]');
    if (op) { try { if (typeof openPoDetailModal === 'function') openPoDetailModal(op.dataset.openPo); } catch (_) {} return; }
    const cp = t.closest('[data-copy]');
    if (cp) { copyAnswer(+cp.dataset.copy, cp); return; }
    const f = t.closest('[data-fix]');
    if (f) { flag(+f.dataset.fix); return; }
    const rt = t.closest('[data-retry]');
    if (rt) { const m = state.msgs[+rt.dataset.retry]; if (m) { const qtext = m.q; state.msgs.splice(+rt.dataset.retry - 1, 2); ask(qtext, 'system'); } return; }
    const c = t.closest('.ai-cite');
    if (c) { const m = state.msgs[+c.dataset.mi]; const s2 = m && m.a && (m.a.sources || []).find((x) => String(x.n) === c.dataset.cite); if (s2) go(s2.link); return; }
    const l = t.closest('[data-link]');
    if (l) { try { go(JSON.parse(l.dataset.link)); } catch (_) {} }
  }

  function onKey(e) {
    if (modelMenuOpen()) {
      const items = [...document.querySelectorAll('#ai-panel .ai-model-opt')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); modelMenu(false); document.querySelector('#ai-panel [data-model-menu]')?.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        return;
      }
      if (e.key === 'Tab') modelMenu(false);
    }
    if (e.key === 'Escape') {
      if (popFor) { hidePop(); e.stopPropagation(); return; }
      e.stopPropagation();
      close();
    }
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.code === 'Slash')) {
      if (!allowed()) return;
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && state.open && !document.querySelector('#modal-overlay.active')) {
      const p = document.getElementById('ai-panel');
      if (p && !p.contains(document.activeElement)) close();
    }
  });

  // ── Header button ─────────────────────────────────────────────────────────────────────────────
  function syncBtn() {
    const b = document.getElementById('ai-hdr-btn');
    if (!b) return;
    b.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    b.classList.toggle('is-on', state.open);
    const label = T('مساعد SOULIA (Ctrl+/)', 'SOULIA Assistant (Ctrl+/)');
    b.title = label;
    b.setAttribute('aria-label', label);
  }
  function mountBtn() {
    if (!allowed()) {
      document.getElementById('ai-hdr-btn')?.remove();
      if (state.open) close();
      return;
    }
    const host = document.querySelector('#header .header-actions');
    if (!host || document.getElementById('ai-hdr-btn')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'ai-hdr-btn';
    b.className = 'ai-hdr-btn';
    b.style.order = '0';
    b.setAttribute('aria-haspopup', 'dialog');
    b.innerHTML = ICON.spark;
    b.addEventListener('click', toggle);
    host.insertBefore(b, host.firstChild);
    syncBtn();
    syncBadge();
  }

  // Language switch: redraw in the new language (answers already given stay as written).
  function relang() { mountBtn(); syncBtn(); if (state.open) shell(); }

  window.SouliaAssistant = { open: (q) => { if (allowed()) open(q); }, close, toggle: () => { if (allowed()) toggle(); }, ask: (q) => { if (allowed()) open(q); }, relang, sync: mountBtn };
  // updateHeader() runs after sign-in and whenever the account is refreshed: re-check the permission then.
  if (typeof window.updateHeader === 'function' && !window.updateHeader.__ai) {
    const origHeader = window.updateHeader;
    window.updateHeader = function () { const r = origHeader.apply(this, arguments); try { mountBtn(); } catch (_) {} return r; };
    window.updateHeader.__ai = true;
  }
  // applyLang() is a global function declaration — wrap it so the panel follows a language switch.
  if (typeof window.applyLang === 'function' && !window.applyLang.__ai) {
    const orig = window.applyLang;
    window.applyLang = function () { const r = orig.apply(this, arguments); try { relang(); } catch (_) {} return r; };
    window.applyLang.__ai = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBtn); else mountBtn();
  // Admins get the morning report counter without opening the panel (checked after sign-in, then every 30 min).
  // Questions still waiting on the external assistant keep being checked after a page reload, panel closed or not.
  setTimeout(function tick() {
    mountBtn();
    if (allowed()) {
      loadDaily(false); bindSocket();
      if (!state.msgs.length) restore();
      armExternalPoll();
    }
    setTimeout(tick, 60_000);
  }, 6000);
})();
