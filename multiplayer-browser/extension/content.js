/**
 * Multiplayer Browser - Content Script
 * Renders cursors, handles navigation sync, annotations
 */
(function () {
  const SERVER_URL = 'http://localhost:4000';
  let overlay = null;
  let cursors = new Map();
  let annotations = new Map();
  let roomId = null;
  let myId = null;
  let cursorThrottle = null;
  let lastCursor = { x: 0, y: 0 };

  function getOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mpb-overlay';
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  function createCursor(id, name, color) {
    const el = document.createElement('div');
    el.className = 'mpb-cursor';
    el.dataset.id = id;
    el.innerHTML = `
      <svg class="mpb-cursor-svg" viewBox="0 0 24 24" fill="${color}">
        <path d="M5.65 3.25l10.5 10.5-4.2 2.1-2.55-2.55-2.1 4.2-2.1-2.1 2.1-4.2-2.55-2.55-2.1 4.2z"/>
      </svg>
      <span class="mpb-cursor-label" style="background:${color}">${escapeHtml(name)}</span>
    `;
    el.style.left = '0px';
    el.style.top = '0px';
    getOverlay().appendChild(el);
    return el;
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function onCursorMove(data) {
    if (data.id === myId) return;
    let el = cursors.get(data.id);
    if (!el) {
      el = createCursor(data.id, data.name, data.color);
      cursors.set(data.id, el);
    }
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
  }

  function onUserLeft(id) {
    const el = cursors.get(id);
    if (el) el.remove();
    cursors.delete(id);
  }

  function onNavigate(data) {
    const url = data?.url || data;
    if (!url || window.location.href === url) return;
    window.location.href = url;
  }

  function onChatMessage(data) {
    if (window.mpbOnChatMessage) window.mpbOnChatMessage(data);
  }

  function onAnnotationAdd(data) {
    const el = document.createElement('div');
    el.className = 'mpb-annotation';
    el.dataset.id = data.id || Date.now();
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.width = data.w + 'px';
    el.style.height = data.h + 'px';
    el.style.background = data.color || '#6C5CE7';
    getOverlay().appendChild(el);
    annotations.set(el.dataset.id, el);
  }

  function onAnnotationRemove(id) {
    const el = annotations.get(id);
    if (el) el.remove();
    annotations.delete(id);
  }

  function onScrollSync(data) {
    if (data.id === myId) return;
    window.scrollTo(data.scrollX || 0, data.scrollY || 0);
  }

  document.addEventListener('mousemove', (e) => {
    if (!roomId) return;
    lastCursor = { x: e.clientX, y: e.clientY };
    if (!cursorThrottle) {
      cursorThrottle = setTimeout(() => {
        chrome.runtime.sendMessage({
          type: 'CURSOR',
          data: { x: lastCursor.x, y: lastCursor.y }
        }).catch(() => {});
        cursorThrottle = null;
      }, 50);
    }
  }, { passive: true });

  window.addEventListener('scroll', () => {
    if (!roomId) return;
    if (window.mpScrollThrottle) clearTimeout(window.mpScrollThrottle);
    window.mpScrollThrottle = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'SCROLL',
        data: { scrollX: window.scrollX, scrollY: window.scrollY }
      }).catch(() => {});
    }, 200);
  }, { passive: true });

  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = function (...args) {
    origPushState(...args);
    if (roomId) chrome.runtime.sendMessage({ type: 'NAVIGATE', url: window.location.href }).catch(() => {});
  };
  history.replaceState = function (...args) {
    origReplaceState(...args);
    if (roomId) chrome.runtime.sendMessage({ type: 'NAVIGATE', url: window.location.href }).catch(() => {});
  };
  window.addEventListener('popstate', () => {
    if (roomId) chrome.runtime.sendMessage({ type: 'NAVIGATE', url: window.location.href }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'mp-init') {
      roomId = msg.roomId;
      myId = msg.myId;
      if (roomId) {
        chrome.runtime.sendMessage({ type: 'NAVIGATE', url: window.location.href }).catch(() => {});
      }
      return;
    }
    switch (msg.type) {
      case 'cursor-move': onCursorMove(msg.data); break;
      case 'user-left': onUserLeft(msg.data?.id); break;
      case 'navigate': onNavigate(msg.data); break;
      case 'chat-message': onChatMessage(msg.data); break;
      case 'annotation-add': onAnnotationAdd(msg.data); break;
      case 'annotation-remove': onAnnotationRemove(msg.data); break;
      case 'scroll-sync': onScrollSync(msg.data); break;
    }
  });

  window.mpSetRoom = (id, uid) => {
    roomId = id;
    myId = uid;
  };

  window.mpGetRoom = () => roomId;
})();
