# Capture Cursor API traffic (for CrossUsage / debugging)

You want to see **which hosts and paths** Cursor uses when you chat, refresh usage, etc. Options below.

## 1. Built-in (easiest): Cursor Developer Tools

1. **Help → Toggle Developer Tools** (or `Ctrl+Shift+I` / `Cmd+Option+I`).
2. Open the **Network** tab.
3. Clear, then **send a chat message** or open **Settings → Account** (usage).
4. Filter by **Fetch/XHR** or search `cursor` / `api2`.
5. Click a request → **Headers** (URL, method) and **Payload** / **Response** (if not opaque).

**Limits:** Only traffic from the Electron/Chromium layer you see here; some subprocesses might not appear. No extra install.

---

## 2. mitmproxy / mitmweb (full proxy capture)

You already run something like:

```bash
mitmweb --listen-port 8080
```

- **Proxy:** `127.0.0.1:8080`
- **Web UI:** usually **`http://127.0.0.1:8081`** (open this in a browser to browse captured flows).

### Make Cursor use the proxy (Linux)

```bash
export HTTP_PROXY=http://127.0.0.1:8080
export HTTPS_PROXY=http://127.0.0.1:8080
export ALL_PROXY=http://127.0.0.1:8080
cursor   # or path to Cursor binary
```

Or set the same in **Desktop Environment** network proxy settings (applies to many apps).

### Trust mitmproxy’s CA (required for HTTPS)

Without this, you see CONNECT tunnels but not decrypted bodies.

1. After starting mitm, install the cert:  
   `~/.mitmproxy/mitmproxy-ca-cert.pem` (or use **http://mitm.it** from a browser *using* the proxy).
2. Linux: copy to `/usr/local/share/ca-certificates/` and `sudo update-ca-certificates`, or use your distro’s trust store UI.

### Important limitations

- **Certificate pinning:** Some clients refuse custom CAs; then you only see **host:port**, not decrypted JSON.
- **Non-HTTP:** gRPC-over-HTTP/2 may still show as HTTP/2 in mitm if decrypted.
- **Privacy:** You are intercepting your own traffic; don’t share tokens in screenshots.

---

## 3. What to send to CrossUsage contributors

For each interesting call, note:

| Field | Example |
|-------|--------|
| **Full URL** | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| **Method** | POST |
| **Status** | 200 / 400 |
| **Request headers** (redact `Authorization`) | `Connect-Protocol-Version`, `Content-Type` |
| **Request body** | often `{}` for Connect |
| **Response** (shape only if huge) | keys under `planUsage`, errors with `detail` |

Redact **Bearer tokens**, cookies, and emails.

---

## 4. If proxy breaks Cursor

Unset proxy and restart Cursor:

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY
```

---

## Quick answer to “open localhost”

- **mitmweb UI:** open **`http://127.0.0.1:8081`** in your browser (default when proxy listens on `8080`).
- If the UI is on another port, check the terminal output for `http://...`.
