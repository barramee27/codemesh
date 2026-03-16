/**
 * Multiplayer Browser - Background Service Worker
 * Connects to server, relays messages to/from content scripts
 */
importScripts('libs/socket.io.min.js');

const SERVER_URL = 'http://localhost:4000';
let socket = null;
let roomId = null;
let userName = null;
let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.onDisconnect.addListener(() => { popupPort = null; });
  }
});

function connect() {
  if (socket?.connected) return socket;
  const io = self.io;
  if (!io) {
    console.error('[Multiplayer] Socket.IO not loaded');
    return null;
  }
  socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
  });
  socket.on('connect', () => console.log('[Multiplayer] Connected'));
  socket.on('disconnect', () => console.log('[Multiplayer] Disconnected'));
  return socket;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'JOIN') {
    const s = connect();
    if (!s) return sendResponse({ error: 'Socket not ready' });
    roomId = msg.roomId;
    userName = msg.userName || 'Guest';
    s.emit('join-room', { roomId, userName });
    s.once('room-joined', (data) => {
      setupForwarding(s);
      sendResponse(data);
    });
    return true;
  }

  if (msg.type === 'LEAVE') {
    roomId = null;
    userName = null;
    sendResponse({ ok: true });
    return true;
  }

  const s = socket || connect();
  if (!s) return sendResponse({ error: 'Socket not ready' });

  if (msg.type === 'CURSOR') {
    s.emit('cursor-move', msg.data);
    return false;
  }
  if (msg.type === 'NAVIGATE') {
    s.emit('navigate', msg.url);
    return false;
  }
  if (msg.type === 'CHAT') {
    s.emit('chat-message', msg.text);
    return false;
  }
  if (msg.type === 'ANNOTATION_ADD') {
    s.emit('annotation-add', msg.data);
    return false;
  }
  if (msg.type === 'ANNOTATION_REMOVE') {
    s.emit('annotation-remove', msg.id);
    return false;
  }
  if (msg.type === 'SCROLL') {
    s.emit('scroll-sync', msg.data);
    return false;
  }
  if (msg.type === 'VOICE_OFFER') {
    s.emit('voice-offer', msg.data);
    return false;
  }
  if (msg.type === 'VOICE_ANSWER') {
    s.emit('voice-answer', msg.data);
    return false;
  }
  if (msg.type === 'VOICE_ICE') {
    s.emit('voice-ice', msg.data);
    return false;
  }

  return false;
});

function setupForwarding(sock) {
  const s = sock || socket || connect();
  if (!s) return;
  ['user-joined', 'user-left', 'cursor-move', 'navigate', 'chat-message', 'annotation-add', 'annotation-remove', 'scroll-sync', 'voice-offer', 'voice-answer', 'voice-ice'].forEach(ev => {
    s.off(ev);
    s.on(ev, (data) => {
      if (popupPort) popupPort.postMessage({ type: ev, data }).catch(() => {});
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
            chrome.tabs.sendMessage(tab.id, { type: ev, data }).catch(() => {});
          }
        });
      });
    });
  });
}
