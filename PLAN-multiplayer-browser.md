# Plan: Turn Any Site Into Multiplayer

**Project:** Browser extension that adds real-time multiplayer (shared cursors, chat, voice, annotations) to any webpage.

---

## Overview

A Chrome extension that lets you browse any website with others in real time. **When anyone navigates to a URL, everyone in the room automatically follows** — including any site. Shared cursors, text chat, voice chat, scroll sync, and annotations.

---

## Core Features

1. **Shared cursors** — See where others are on the page (colored cursor + name label)
2. **Navigation sync** — When anyone goes to a URL, everyone in the room follows automatically
3. **Text chat** — In-extension chat for the room
4. **Voice chat** — WebRTC peer-to-peer audio (signaling via Socket.IO)
5. **Annotations** — Highlight areas (API ready)
6. **Room-based** — Create or join a room; share the room ID
7. **Works on any site** — Content script injects overlay; no server-side changes needed

---

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Content Script │ ◄────────────────► │  Backend Server │
│  (any webpage)  │                     │  (Node/Socket.IO)│
└────────┬────────┘                     └────────┬────────┘
         │                                       │
         │  chrome.runtime                       │
         ▼                                       │
┌─────────────────┐                              │
│  Background SW  │ ◄────────────────────────────┘
│  (extension)    │
└─────────────────┘
```

- **Content script:** Injected into every tab. Renders cursor overlays, handles annotations, sends/receives events.
- **Background service worker:** Connects to backend via WebSocket, relays messages to content script.
- **Backend:** Node.js + Socket.IO. Rooms, presence, cursor/annotation sync. Can reuse CodeMesh-style auth or keep it simple (room ID only).

---

## Tech Stack


| Layer     | Choice                                                       |
| --------- | ------------------------------------------------------------ |
| Extension | Manifest V3, vanilla JS                                      |
| Backend   | Node.js, Express, Socket.IO                                  |
| Real-time | Socket.IO rooms                                              |
| Storage   | Optional: MongoDB for room persistence, or in-memory for MVP |


---

## File Structure

```
multiplayer-browser/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.js
│   └── styles/
│       └── overlay.css
├── server/
│   ├── package.json
│   ├── server.js
│   └── ...
└── README.md
```

---

## Implementation Phases

### Phase 1: Extension shell + backend

- Create `manifest.json` (Manifest V3)
- Background script: connect to backend WebSocket
- Popup: "Create room" / "Join room" (paste room ID or link)
- Backend: Socket.IO server with rooms, basic join/leave

### Phase 2: Cursor sync

- Content script: inject cursor overlay (absolute-positioned divs)
- Send `mousemove` (throttled) to backend
- Broadcast cursor position to room
- Render other users' cursors with name + color

### Phase 3: Page sync

- Sync current URL when someone navigates (optional: broadcast navigation to room)
- Or: room = URL + roomId (e.g. `roomId` in hash: `example.com#room-abc123`)

### Phase 4: Annotations

- Text selection → "Add highlight" → store (range, color, author)
- Render highlights as overlay
- Optional: sticky notes at x,y

### Phase 5: Polish

- Scroll sync (optional)
- Room expiry / cleanup
- Simple landing page to create/join rooms

---

## Constraints & Considerations

- **CSP:** Some sites block inline scripts. Content script runs in isolated world; overlay is our DOM. May need to handle `frame-src` restrictions for WebSocket in rare cases.
- **Performance:** Throttle cursor updates (e.g. 50ms). Limit annotations per page.
- **Privacy:** All data flows through our backend. Clear privacy policy.

---

## MVP Scope (Recommended First Build)

1. Extension: popup to create/join room
2. Backend: Socket.IO rooms, cursor broadcast
3. Content script: cursor overlay only (no annotations yet)
4. Works on HTTP/HTTPS pages

---

## Out of Scope (For Later)

- Screen sharing
- Voice/video
- Persistent annotations (stored in DB, reload survives)
- Mobile support

---

## Next Steps

1. **If you say "do it"** — Start with Phase 1 (extension shell + backend).
2. **If you want changes** — Tell me what to add, remove, or adjust.
3. **If you want it elsewhere** — I can create this in a new folder (e.g. `~/multiplayer-browser`) or inside codemesh.

