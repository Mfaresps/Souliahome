/* Shared by follow-up trails, invoice comments and Shopify conversations. */
const commentReactionChoices = [
  ['like', '👍', 'إعجاب', 'Like'], ['applause', '👏', 'تسقيفة', 'Applause'],
  ['strong', '💪', 'عاش', 'Well done'], ['love', '❤️', 'حب', 'Love'],
  ['fire', '🔥', 'جامد', 'Awesome'], ['star', '🌟', 'برافو', 'Bravo'],
];
const commentReactionTargets = new Map();
const commentReactionPending = new Set();
function commentReactionsHtml(kind, target, commentId) {
  if (!target?._id || commentId == null) return '';
  const id = String(target._id), cid = String(commentId), key = kind + ':' + id;
  commentReactionTargets.set(key, target);
  const en = currentLang === 'en', me = String(currentUser?._id || currentUser?.id || '');
  const rows = (target.commentReactions || []).filter(r => r.commentId === cid);
  const busy = commentReactionPending.has(key + ':' + cid);
  const chips = commentReactionChoices.map(([value, emoji, ar, eng]) => {
    const matches = rows.filter(r => r.reaction === value);
    if (!matches.length) return '';
    const mine = matches.some(r => r.userId === me), label = en ? eng : ar;
    const title = label + ': ' + matches.map(r => r.userName || (en ? 'Colleague' : 'زميل')).join('، ');
    return `<button type="button" class="cmt-reaction-chip${mine ? ' is-mine' : ''}" data-reaction="${value}" aria-pressed="${mine}" title="${escHtml(title)}" aria-label="${escHtml(title)}" ${busy ? 'disabled' : ''}><span>${emoji}</span><span>${fmtN(matches.length)}</span></button>`;
  }).join('');
  const label = en ? 'Encourage' : 'شجّع';
  return `<div class="cmt-reactions" data-kind="${escHtml(kind)}" data-target="${escHtml(id)}" data-comment="${escHtml(cid)}" aria-busy="${busy}">
    <div class="cmt-reaction-summary">${chips}<button type="button" class="cmt-reaction-add" aria-expanded="false" aria-label="${label}" ${busy ? 'disabled' : ''}><span aria-hidden="true">☺＋</span> ${label}</button></div>
    <div class="cmt-reaction-picker" role="group" aria-label="${label}" hidden>${commentReactionChoices.map(([value, emoji, ar, eng]) => `<button type="button" data-reaction="${value}" aria-pressed="${rows.some(r => r.userId === me && r.reaction === value)}" ${busy ? 'disabled' : ''}><span>${emoji}</span><small>${en ? eng : ar}</small></button>`).join('')}</div>
  </div>`;
}
function closeCommentReactionPickers(focus = false) {
  document.querySelectorAll('.cmt-reaction-picker:not([hidden])').forEach(picker => {
    picker.hidden = true;
    const button = picker.parentElement.querySelector('.cmt-reaction-add');
    button?.setAttribute('aria-expanded', 'false');
    if (focus) button?.focus({ preventScroll: true });
  });
}
function applyCommentReactionUpdate(payload) {
  const { kind, id, commentId, reactions } = payload || {};
  if (!Array.isArray(reactions)) return;
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
    const picker = host.querySelector('.cmt-reaction-picker'), open = picker.hidden;
    closeCommentReactionPickers(); picker.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    return;
  }
  const { kind, target: id, comment: commentId } = host.dataset;
  const key = kind + ':' + id + ':' + commentId;
  if (!button.dataset.reaction || commentReactionPending.has(key)) return;
  const reaction = button.getAttribute('aria-pressed') === 'true' ? null : button.dataset.reaction;
  const prefix = { followup: '/followups/', transaction: '/transactions/', shopify: '/shopify/orders/' }[kind];
  if (!prefix) return;
  commentReactionPending.add(key);
  host.setAttribute('aria-busy', 'true');
  host.querySelectorAll('button').forEach(b => b.disabled = true);
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
  if (event.key === 'Escape' && document.querySelector('.cmt-reaction-picker:not([hidden])')) {
    event.preventDefault(); event.stopImmediatePropagation(); closeCommentReactionPickers(true);
  }
}, true);
