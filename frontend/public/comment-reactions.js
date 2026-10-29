/* Shared by follow-up trails, invoice comments and Shopify conversations. */
const commentReactionChoices = [
  ['like', '👍', 'إعجاب', 'Like'], ['applause', '👏', 'تسقيفة', 'Applause'],
  ['strong', '💪', 'عاش', 'Well done'], ['love', '❤️', 'حب', 'Love'],
  ['fire', '🔥', 'جامد', 'Awesome'], ['star', '🌟', 'برافو', 'Bravo'],
  ['angry', '😠', 'غضب', 'Angry'],
];
const commentReactionTargets = new Map();
const commentReactionPending = new Set();
let commentReactionPopover = null;
function commentReactionsHtml(kind, target, commentId) {
  if (!target?._id || commentId == null) return '';
  const id = String(target._id), cid = String(commentId), key = kind + ':' + id;
  commentReactionTargets.set(key, target);
  const en = currentLang === 'en', me = String(currentUser?.userId || currentUser?._id || currentUser?.id || '');
  const rows = (target.commentReactions || []).filter(r => r.commentId === cid);
  const busy = commentReactionPending.has(key + ':' + cid);
  const chips = commentReactionChoices.map(([value, emoji, ar, eng]) => {
    const matches = rows.filter(r => r.reaction === value);
    if (!matches.length) return '';
    const mine = matches.some(r => r.userId === me), label = en ? eng : ar;
    const title = label + ': ' + matches.map(r => r.userName || (en ? 'Colleague' : 'زميل')).join('، ');
    return `<button type="button" class="cmt-reaction-chip${mine ? ' is-mine' : ''}" data-reaction="${value}" aria-pressed="${mine}" title="${escHtml(title)}" aria-label="${escHtml(title)}" ${busy ? 'disabled' : ''}><span>${emoji}</span><span>${fmtN(matches.length)}</span></button>`;
  }).join('');
  const label = en ? 'Add reaction' : 'إضافة تفاعل';
  return `<div class="cmt-reactions" data-kind="${escHtml(kind)}" data-target="${escHtml(id)}" data-comment="${escHtml(cid)}" aria-busy="${busy}">
    <div class="cmt-reaction-summary">${chips}<button type="button" class="cmt-reaction-add" aria-expanded="false" aria-label="${label}" title="${label}" ${busy ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12v1a8 8 0 1 1-8-8h1"/><path d="M7.5 14s1.3 2 3.5 2 3.5-2 3.5-2"/><path d="M8 10h.01M14 10h.01M19 2v6M16 5h6"/></svg></button></div>
    <div class="cmt-reaction-picker" role="group" aria-label="${label}" hidden>${commentReactionChoices.map(([value, emoji, ar, eng]) => `<button type="button" data-reaction="${value}" aria-pressed="${rows.some(r => r.userId === me && r.reaction === value)}" ${busy ? 'disabled' : ''}><span>${emoji}</span><small>${en ? eng : ar}</small></button>`).join('')}</div>
  </div>`;
}
function closeCommentReactionPickers(focus = false) {
  if (!commentReactionPopover) return;
  const { button, portal } = commentReactionPopover;
  commentReactionPopover = null;
  portal.remove();
  button.setAttribute('aria-expanded', 'false');
  if (focus && button.isConnected) button.focus({ preventScroll: true });
}
function openCommentReactionPicker(button) {
  const wasOpen = commentReactionPopover?.button === button;
  closeCommentReactionPickers();
  if (wasOpen) return;
  const host = button.closest('.cmt-reactions');
  const portal = document.createElement('div');
  portal.className = 'cmt-reactions cmt-reaction-popover';
  Object.assign(portal.dataset, host.dataset);
  portal.dir = currentLang === 'en' ? 'ltr' : 'rtl';
  const picker = host.querySelector('.cmt-reaction-picker').cloneNode(true);
  picker.hidden = false; portal.append(picker); document.body.append(portal);
  const rect = button.getBoundingClientRect();
  const width = portal.offsetWidth, height = portal.offsetHeight;
  const left = portal.dir === 'rtl' ? rect.right - width : rect.left;
  portal.style.left = Math.max(8, Math.min(innerWidth - width - 8, left)) + 'px';
  portal.style.top = Math.max(8, rect.top - height - 7) + 'px';
  commentReactionPopover = { button, portal };
  button.setAttribute('aria-expanded', 'true');
  picker.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  if (!portal.contains(document.activeElement)) picker.querySelector('button')?.focus({ preventScroll: true });
}
function applyCommentReactionUpdate(payload) {
  const { kind, id, commentId, reactions } = payload || {};
  if (!Array.isArray(reactions)) return;
  const open = commentReactionPopover?.portal.dataset;
  if (open?.kind === kind && open.target === id && open.comment === commentId) closeCommentReactionPickers(true);
  const targets = [commentReactionTargets.get(kind + ':' + id)];
  if (kind === 'followup' && typeof followUps !== 'undefined') targets.push(...followUps.filter(x => String(x._id) === id));
  if (kind === 'transaction' && typeof transactions !== 'undefined') targets.push(...transactions.filter(x => String(x._id) === id));
  if (kind === 'shopify' && typeof _shopifyOrders !== 'undefined') targets.push(..._shopifyOrders.filter(x => String(x._id) === id));
  targets.filter(Boolean).forEach(target => {
    target.commentReactions = (target.commentReactions || []).filter(r => r.commentId !== commentId).concat(reactions);
  });
  const target = targets.find(Boolean);
  if (!target) return;
  // Replace only reaction controls: preserve the draft, inline edits and scroll position.
  document.querySelectorAll('.cmt-reactions').forEach(el => {
    if (el.dataset.kind === kind && el.dataset.target === id && el.dataset.comment === commentId) {
      const focused = el.contains(document.activeElement);
      const holder = document.createElement('div');
      holder.innerHTML = commentReactionsHtml(kind, target, commentId);
      const replacement = holder.firstElementChild;
      el.replaceWith(replacement);
      if (focused) replacement.querySelector('.cmt-reaction-add')?.focus({ preventScroll: true });
    }
  });
}
document.addEventListener('click', async event => {
  const button = event.target.closest?.('.cmt-reactions button');
  if (!button) { closeCommentReactionPickers(); return; }
  event.stopPropagation();
  const host = button.closest('.cmt-reactions');
  if (button.classList.contains('cmt-reaction-add')) {
    openCommentReactionPicker(button);
    return;
  }
  const { kind, target: id, comment: commentId } = host.dataset;
  const key = kind + ':' + id + ':' + commentId;
  if (!button.dataset.reaction || commentReactionPending.has(key)) return;
  const reaction = button.getAttribute('aria-pressed') === 'true' ? null : button.dataset.reaction;
  const prefix = { followup: '/followups/', transaction: '/transactions/', shopify: '/shopify/orders/' }[kind];
  if (!prefix) return;
  closeCommentReactionPickers(true);
  commentReactionPending.add(key);
  document.querySelectorAll('.cmt-reactions').forEach(el => {
    if (el.dataset.kind === kind && el.dataset.target === id && el.dataset.comment === commentId) {
      el.setAttribute('aria-busy', 'true'); el.querySelectorAll('button').forEach(b => b.disabled = true);
    }
  });
  try {
    const result = await api(`${prefix}${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/reaction`, {
      method: 'PATCH', body: JSON.stringify({ reaction }),
    });
    commentReactionPending.delete(key);
    applyCommentReactionUpdate({ kind, id, ...result });
  } catch (_) {
    toast(currentLang === 'en' ? 'Could not save your reaction. Try again.' : 'تعذّر حفظ التفاعل. حاول مرة تانية.', true);
  } finally {
    commentReactionPending.delete(key);
    document.querySelectorAll('.cmt-reactions').forEach(el => {
      if (el.dataset.kind === kind && el.dataset.target === id && el.dataset.comment === commentId) {
        el.setAttribute('aria-busy', 'false'); el.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    });
  }
});
document.addEventListener('keydown', event => {
  if (!commentReactionPopover) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation(); closeCommentReactionPickers(true);
  } else if (['Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    const buttons = [...commentReactionPopover.portal.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement);
    const delta = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : (event.key === 'ArrowLeft' ? -1 : 1);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + delta + buttons.length) % buttons.length;
    event.preventDefault(); event.stopImmediatePropagation(); buttons[next]?.focus();
  }
}, true);
window.addEventListener('resize', () => closeCommentReactionPickers());
document.addEventListener('scroll', event => {
  if (commentReactionPopover && !commentReactionPopover.portal.contains(event.target)) closeCommentReactionPickers();
}, true);
