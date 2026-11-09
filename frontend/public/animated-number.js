// Vanilla JavaScript adaptation of Hirael Animated Number (MIT).
// Source: https://hirael.com/components/data/animated-number
(function (root) {
  'use strict';

  const animations = new WeakMap();
  const easeOutCubic = progress => 1 - Math.pow(1 - progress, 3);
  const reducedMotion = () => root.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  function set(element, value, options = {}) {
    if (!element) return;
    const target = Number(value);
    if (!Number.isFinite(target)) throw new TypeError('AnimatedNumber value must be finite');

    const {
      startValue = 0, duration = 700, decimals = 0, format = {},
      locale = 'en-US', prefix = '', suffix = '',
    } = options;
    const formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      ...format,
    });
    const decorate = number => `${prefix}${formatter.format(number)}${suffix}`;
    const finalText = decorate(target);
    const prior = animations.get(element);
    const signature = JSON.stringify([target, duration, decimals, format, locale, prefix, suffix]);
    if (prior?.signature === signature && element.querySelector(':scope > .animated-number-visible')) return;
    if (prior?.frame) root.cancelAnimationFrame(prior.frame);

    const from = prior?.display ?? Number(startValue);
    const state = { signature, display: from, frame: 0 };
    animations.set(element, state);

    let accessible = element.querySelector(':scope > .animated-number-sr');
    let visible = element.querySelector(':scope > .animated-number-visible');
    if (!accessible || !visible) {
      element.replaceChildren();
      accessible = document.createElement('span');
      accessible.className = 'animated-number-sr';
      accessible.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
      visible = document.createElement('span');
      visible.className = 'animated-number-visible';
      visible.setAttribute('aria-hidden', 'true');
      element.append(accessible, visible);
    }
    accessible.textContent = finalText;
    element.dataset.animatedNumberFinal = finalText;
    element.style.fontVariantNumeric = 'tabular-nums';
    visible.style.minWidth = `${finalText.length}ch`;
    visible.style.display = 'inline-block';

    if (reducedMotion() || duration <= 0 || from === target || !root.requestAnimationFrame) {
      state.display = target;
      visible.textContent = finalText;
      return;
    }

    const started = performance.now();
    visible.textContent = decorate(from);
    const tick = now => {
      if (animations.get(element) !== state || !element.isConnected) return;
      if (reducedMotion()) {
        state.display = target;
        visible.textContent = finalText;
        return;
      }
      const progress = Math.min(1, Math.max(0, (now - started) / duration));
      state.display = progress < 1 ? from + (target - from) * easeOutCubic(progress) : target;
      visible.textContent = progress < 1 ? decorate(state.display) : finalText;
      if (progress < 1) state.frame = root.requestAnimationFrame(tick);
      else state.frame = 0;
    };
    state.frame = root.requestAnimationFrame(tick);
  }

  root.AnimatedNumber = Object.freeze({ set });
})(window);
