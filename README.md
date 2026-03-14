# CodeMesh

**Real-time collaborative code editing platform** — Create sessions, share code, and edit together with zero-lag synchronization.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **Real-time collaboration** — Multiple users editing the same code with live sync
- **Multi-language support** — JavaScript, Python, TypeScript, HTML, CSS, Java, C++, and more
- **Code execution** — Run Python, JavaScript, and other languages directly
- **HTML preview** — Live preview of HTML in a dedicated window
- **Session management** — Create, join, and share coding sessions
- **Role-based access** — Owner, Editor, and Viewer roles

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
```

### Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Supported Languages

| Language   | Execution | Preview |
|-----------|-----------|---------|
| JavaScript | ✅ | - |
| Python     | ✅ | - |
| TypeScript | ✅ | - |
| HTML       | - | ✅ Live preview |
| CSS        | - | - |
| Java, C++, Go, Rust, PHP, Ruby | ✅ | - |

## Project Structure

```
codemesh/
├── middleware/    # Auth, admin middleware
├── models/        # User, Session models
├── routes/        # API routes (auth, sessions, run)
├── sockets/       # WebSocket collaboration
├── public/        # Frontend (HTML, CSS, JS)
├── utils/         # Utilities
└── server.js      # Entry point
```

## License

MIT © [barramee27](https://github.com/barramee27)
