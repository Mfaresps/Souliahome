/* One same-document history for route buttons and browser Back/Forward.
 * Entries are private to this document: a shared link never sends Back outside the app. */
window.SouliaNavigation = (() => {
  let config, entries = [], index = 0, sequence = 0, pending = null;
  let installed = false, routingPop = false, moving = false, rollback = null, lastSeenURL = location.href;
  const pendingHashEvents = new Map();
  let scrollCleanup = null;
  const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const nativePush = history.pushState.bind(history), nativeReplace = history.replaceState.bind(history);
  const absolute = value => new URL(value == null ? location.href : value, location.href).href;
  const stamp = (state, id) => ({ ...(state && typeof state === 'object' ? state : {}), __souliaRoute: { session, id } });
  function record(url, id = ++sequence) {
    return { id, url, ...config.resolve(url), snapshot: null };
  }
  function notify() {
    queueMicrotask(() => { try { config.changed?.(); } catch (_) {} });
  }
  function capture(entry) {
    try {
      const snapshot = config.snapshot(entry.page, entry.url);
      if (snapshot) entry.snapshot = snapshot;
    } catch (_) { /* Routing remains usable if an optional screen cannot be snapshotted. */ }
    return entry;
  }
  function previous() {
    const current = entries[index];
    if (!current) return null;
    for (let i = index - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.url !== current.url && config.allowed(entry.page, entry.url)) return { ...entry, index: i };
    }
    return null;
  }
  function target() {
    const entry = previous();
    return entry ? { ...entry.snapshot, page: entry.page, url: entry.url, detail: entry.detail, index: entry.index } : null;
  }
  function restoreScroll(entry) {
    scrollCleanup?.();
    const snap = entry.snapshot;
    if (!snap?.scroll) return;
    let frame = 0, observer;
    const stop = () => {
      cancelAnimationFrame(frame); observer?.disconnect(); clearTimeout(timeout);
      ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(type => window.removeEventListener(type, stop, true));
      if (scrollCleanup === stop) scrollCleanup = null;
    };
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (entries[index]?.id !== entry.id || location.href !== entry.url) { stop(); return; }
        snap.restoreDom?.();
        window.scrollTo(snap.scroll.x, snap.scroll.y);
        for (const item of snap.scroll.containers || []) {
          const element = item.id ? document.getElementById(item.id) : document.querySelectorAll(item.selector)[item.ordinal || 0];
          if (element) { element.scrollLeft = item.x; element.scrollTop = item.y; }
        }
      });
    };
    const timeout = setTimeout(stop, 5000);
    ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(type => window.addEventListener(type, stop, { capture: true, passive: true }));
    observer = new MutationObserver(apply);
    const main = document.getElementById('main');
    if (main) observer.observe(main, { childList: true, subtree: true });
    scrollCleanup = stop; apply();
  }
  function install(options) {
    if (installed) return;
    installed = true; config = options;
    entries = [record(location.href)]; index = 0;
    nativeReplace(stamp(history.state, entries[0].id), '', location.href);
    history.scrollRestoration = 'manual';
    history.pushState = (state, title, url) => {
      const destination = absolute(url);
      if (new URL(destination).origin !== location.origin) return nativePush(state, title, url);
      const source = entries[index];
      if (pending?.active && pending.url === source.url) source.snapshot = pending.snapshot;
      else capture(source);
      const next = record(destination);
      nativePush(stamp(state, next.id), title, url);
      lastSeenURL = destination;
      entries.splice(index + 1); entries.push(next); index = entries.length - 1; pending = null;
      if (entries.length > 100) { entries.shift(); index--; }
      notify();
    };
    history.replaceState = (state, title, url) => {
      const destination = absolute(url), current = entries[index], route = config.resolve(destination);
      if (new URL(destination).origin !== location.origin) return nativeReplace(state, title, url);
      // Existing ticket screens replace their parent URL after opening a detail.
      // Preserve the parent only when it really was the source; canonical renames stay replacements.
      if (pending?.url === current.url && !current.detail && route.detail && destination !== current.url
          && new URL(destination).hash.split('/')[0] === new URL(current.url).hash.split('/')[0]) {
        pending.active = true;
        return history.pushState(state, title, url);
      }
      nativeReplace(stamp(state, current.id), title, url);
      lastSeenURL = destination;
      if (current.page !== route.page || current.detail !== route.detail) current.snapshot = null;
      Object.assign(current, route, { url: destination }); pending = null;
      notify();
    };
    window.addEventListener('popstate', event => {
      pending = null; moving = false;
      const marker = event.state?.__souliaRoute;
      let nextIndex = marker?.session === session ? entries.findIndex(entry => entry.id === marker.id) : -1;
      routingPop = false;
      if (new URL(lastSeenURL).hash !== location.hash) pendingHashEvents.set(location.href, (pendingHashEvents.get(location.href) || 0) + 1);
      lastSeenURL = location.href;
      if (rollback) {
        if (nextIndex !== rollback.from) {
          if (nextIndex >= 0) history.go(rollback.from - nextIndex);
          return;
        }
        const destination = rollback.to; rollback = null;
        config.confirm(entries[destination].page, () => { moving = true; history.go(destination - index); });
        return;
      }
      if (nextIndex < 0 && !marker) {
        const next = record(location.href);
        entries.splice(index + 1); entries.push(next); nextIndex = entries.length - 1;
        nativeReplace(stamp(event.state, next.id), '', next.url);
      }
      if (nextIndex >= 0 && nextIndex !== index && config.dirty(entries[nextIndex].page)) {
        rollback = { from: index, to: nextIndex };
        history.go(index - nextIndex);
        return;
      }
      const leaving = capture(entries[index]);
      if (nextIndex < 0) {
        const next = record(location.href);
        if (marker) { entries = [next]; index = 0; }
        else { entries.splice(index + 1); entries.push(next); index = entries.length - 1; }
        nextIndex = index;
        nativeReplace(stamp(event.state, next.id), '', next.url);
      }
      index = nextIndex;
      const entry = entries[index];
      if (!config.allowed(entry.page, entry.url)) {
        const safe = config.safe();
        Object.assign(entry, config.resolve(safe), { url: absolute(safe), snapshot: null });
        nativeReplace(stamp(null, entry.id), '', entry.url);
        lastSeenURL = entry.url;
      }
      routingPop = leaving.url !== entry.url;
      if (routingPop) {
        try { entry.snapshot?.restore?.(); } catch (_) {}
        restoreScroll(entry);
      }
      notify();
    });
    window.addEventListener('hashchange', event => {
      if (pendingHashEvents.has(absolute(event.newURL))) return;
      if (entries[index]?.url === location.href) return;
      // Native anchors also create browser history entries, without calling pushState.
      capture(entries[index]);
      const next = record(location.href);
      entries.splice(index + 1); entries.push(next); index = entries.length - 1;
      nativeReplace(stamp(history.state, next.id), '', next.url); pending = null;
      lastSeenURL = next.url;
      notify();
    });
  }
  return {
    install, target,
    prepare(fromPage) {
      if (!installed || routingPop) return;
      const entry = entries[index];
      if (entry.page === fromPage) pending = { url: entry.url, snapshot: config.snapshot(fromPage, entry.url), active: true };
    },
    back() {
      if (!installed) return false;
      if (moving || rollback) return true;
      const entry = previous();
      if (!entry) return false;
      config.confirm(entry.page, () => { moving = true; history.go(entry.index - index); });
      return true;
    },
    shouldRoutePop: () => routingPop,
    skipHashChange(event) {
      const url = event?.newURL && absolute(event.newURL), count = pendingHashEvents.get(url) || 0;
      if (!count) return false;
      if (count === 1) pendingHashEvents.delete(url); else pendingHashEvents.set(url, count - 1);
      return true;
    },
    committed(page) {
      routingPop = false;
      if (pending) pending.active = false;
      if (!location.hash && entries[index]) entries[index].page = page;
    },
    reset() {
      if (!installed) return;
      scrollCleanup?.(); pending = null; rollback = null; moving = false; routingPop = false;
      entries = [record(location.href)]; index = 0;
      pendingHashEvents.clear(); lastSeenURL = location.href;
      nativeReplace(stamp(history.state, entries[0].id), '', location.href);
      notify();
    },
  };
})();
