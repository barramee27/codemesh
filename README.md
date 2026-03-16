# CodeMesh

**Real-time collaborative code editing platform** — Create sessions, share code, and edit together with zero-lag synchronization.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **Real-time collaboration** — Multiple users editing the same code with live sync
- **VS Code-like UI** — Familiar interface with menubar, activity bar, sidebar, and panels
- **Monaco Editor** — Full-featured code editor with syntax highlighting, IntelliSense, and more
- **Multi-language support** — JavaScript, Python, TypeScript, HTML, CSS, Java, C++, Go, Rust, PHP, Ruby, and more
- **Code execution** — Run code directly in the editor with output panel
- **Integrated terminal** — Built-in terminal for running commands (node, python, npm, etc.)
- **HTML preview** — Live preview of HTML in a dedicated panel
- **Multi-file support** — Create and manage multiple files in a session
- **Session management** — Create, join, and share coding sessions
- **Role-based access** — Owner, Editor, and Viewer roles
- **Split editor** — View the same file side-by-side
- **Comments** — Add line comments for collaboration

## Quick Start

### Prerequisites

- Node.js 18+
- MongoDB
- Python 3 (for running Python code)

### Installation

```bash
git clone https://github.com/barramee27/codemesh.git
cd codemesh
npm install
```

### Configuration

Create a `.env` file (optional):

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/codemesh
JWT_SECRET=your-secret-key
NODE_ENV=production
ENABLE_TERMINAL=false  # Set to true to enable terminal (NOT recommended for production)
```

**Security Note**: The integrated terminal is **disabled by default in production** for security. Only enable it (`ENABLE_TERMINAL=true`) if you understand the risks and trust your users. The terminal has a restricted command whitelist and input sanitization, but command execution on the server should be avoided in public deployments.

**Why harden the terminal if the code is open source?**  
Open source means anyone can read the code—it does *not* mean the app is safe to run. If the terminal runs commands on your server, anyone using the app (even without reading the code) can run commands on *your* Railway/server. Hardening limits what they can do.

**What does the 5-second timeout mean?**  
If a command runs longer than 5 seconds, it is stopped. This prevents long-running or infinite loops from blocking the server.

**Password migration**: Existing users with legacy Base64 passwords are automatically migrated to bcrypt on their next successful login. No action required.

### Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Supported Languages

| Language   | Execution | Preview | Editor Support |
|-----------|-----------|---------|---------------|
| JavaScript | ✅ | - | ✅ |
| Python     | ✅ | - | ✅ |
| TypeScript | ✅ | - | ✅ |
| HTML       | - | ✅ Live preview | ✅ |
| CSS        | - | - | ✅ |
| Java       | ✅ | - | ✅ |
| C++        | ✅ | - | ✅ |
| C#         | ✅ | - | ✅ |
| Go         | ✅ | - | ✅ |
| Rust       | ✅ | - | ✅ |
| PHP        | ✅ | - | ✅ |
| Ruby       | ✅ | - | ✅ |
| SQL        | - | - | ✅ |
| Markdown   | - | - | ✅ |

## Project Structure

```
codemesh/
├── middleware/    # Auth, admin middleware
├── models/        # User, Session models
├── routes/        # API routes (auth, sessions, run, terminal)
├── sockets/       # WebSocket collaboration
├── public/        # Frontend (HTML, CSS, JS)
│   ├── css/       # VS Code-style CSS
│   ├── js/        # Main app logic
│   └── index.html # Single-page app
├── utils/         # Utilities (OT algorithms)
└── server.js      # Entry point
```

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO, MongoDB
- **Frontend**: Vanilla JavaScript, Monaco Editor, xterm.js
- **Real-time**: Operational Transform (OT) for conflict-free editing
- **Authentication**: JWT-based auth with guest support

## License

MIT © [barramee27](https://github.com/barramee27)

## Links

- **Live:** [codemesh.org](https://codemesh.org)
- **X (Twitter):** [@Barramee_code](https://x.com/Barramee_code)
- **GitHub:** [barramee27](https://github.com/barramee27)
