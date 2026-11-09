/* Button press and hover feedback for the live, non-React app.
   Individual `scale` composes with existing `transform` rules. */
(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)');
  const controlSelector = 'button, a.btn, input[type="button"], input[type="submit"], input[type="reset"]';
  const hoverScale = 1.01;
  const pressScale = 0.97;
  const states = new WeakMap();
  let pressedButton = null;

  function buttonFrom(target) {
    const button = target instanceof Element ? target.closest(controlSelector) : null;
    return button && !button.matches(':disabled, [aria-disabled="true"]') && !button.closest('[inert]')
      ? button : null;
  }

  function stateFor(button) {
    let state = states.get(button);
    if (!state) {
      state = { scale: 1, pressed: false, hovered: false, animation: null };
      states.set(button, state);
    }
    return state;
  }

  function moveTo(button, scale, duration) {
    if (reduced.matches || !button.isConnected || typeof button.animate !== 'function') return;
    const state = stateFor(button);
    if (state.scale === scale && !state.animation) return;
    const from = parseFloat(getComputedStyle(button).scale) || 1;
    state.animation?.cancel();
    state.animation = null;
    if (Math.abs(from - scale) < 0.001) {
      button.style.scale = String(scale);
      state.scale = scale;
      return;
    }
    const animation = button.animate(
      [{ scale: from }, { scale }],
      { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
    );
    state.animation = animation;
    state.scale = scale;
    animation.onfinish = () => {
      if (state.animation !== animation) return;
      button.style.scale = String(scale);
      animation.cancel();
      state.animation = null;
    };
  }

  function settle(button) {
    if (!button) return;
    const state = stateFor(button);
    state.pressed = false;
    const enabled = !button.matches(':disabled, [aria-disabled="true"]') && !button.closest('[inert]');
    moveTo(button, enabled && hoverCapable.matches && state.hovered ? hoverScale : 1, 180);
  }

  document.addEventListener('pointerover', event => {
    const button = buttonFrom(event.target);
    if (!button || button.contains(event.relatedTarget) || !hoverCapable.matches || event.pointerType === 'touch') return;
    const state = stateFor(button);
    state.hovered = true;
    if (!state.pressed) moveTo(button, hoverScale, 180);
  }, true);

  document.addEventListener('pointerout', event => {
    const button = buttonFrom(event.target);
    if (!button || button.contains(event.relatedTarget) || !hoverCapable.matches || event.pointerType === 'touch') return;
    const state = stateFor(button);
    state.hovered = false;
    if (!state.pressed) moveTo(button, 1, 180);
  }, true);

  document.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const button = buttonFrom(event.target);
    if (!button) return;
    if (pressedButton && pressedButton !== button) settle(pressedButton);
    pressedButton = button;
    const state = stateFor(button);
    state.pressed = true;
    if (event.pointerType === 'touch') state.hovered = false;
    moveTo(button, pressScale, 110);
  }, true);

  function release() {
    settle(pressedButton);
    pressedButton = null;
  }
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);

  document.addEventListener('keydown', event => {
    if (event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
    const button = buttonFrom(event.target);
    if (!button || (button.matches('a') && event.key === ' ')) return;
    if (pressedButton && pressedButton !== button) settle(pressedButton);
    pressedButton = button;
    stateFor(button).pressed = true;
    moveTo(button, pressScale, 110);
  }, true);
  document.addEventListener('keyup', event => {
    if (event.key === ' ' || event.key === 'Enter') release();
  }, true);

  reduced.addEventListener?.('change', () => {
    if (!reduced.matches) return;
    if (pressedButton) release();
    document.querySelectorAll(controlSelector).forEach(button => {
      const state = states.get(button);
      if (!state) return;
      state.animation?.cancel();
      state.animation = null; state.scale = 1; state.pressed = false;
      button.style.removeProperty('scale');
    });
  });
})();
