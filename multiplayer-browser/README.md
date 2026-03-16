# Multiplayer Browser

Browse any website with others in real time. Shared cursors, text chat, voice chat, and **navigation sync** — when anyone in the room navigates to a URL, everyone else automatically follows.

## Features

- **Shared cursors** — See where others are on the page (colored cursor + name)
- **Navigation sync** — When anyone goes to a URL, everyone in the room follows
- **Text chat** — In-extension chat for the room
- **Voice chat** — WebRTC signaling (enable mic in popup)
- **Scroll sync** — Optional scroll position sync
- **Annotations** — Highlight areas (API ready)

## Setup

### 1. Start the server

```bash
cd server
npm install
npm start
```

Server runs on `http://localhost:4000`.

### 2. Install the extension

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension` folder

### 3. Configure server URL (optional)

If the server is not on localhost, edit `SERVER_URL` in:
- `extension/background.js`
- `extension/popup/popup.js`

## Usage

1. Click the extension icon
2. Enter your name and a room ID (or create a new room)
3. Click "Join room"
4. Share the room ID with others
5. Browse — when anyone navigates, everyone follows

## Tech

- **Extension:** Manifest V3, vanilla JS, Socket.IO client
- **Server:** Node.js, Express, Socket.IO
- **Voice:** WebRTC signaling via Socket.IO (peer-to-peer audio)

## License

MIT
