# BekTel Webmail — Backend Integration Spec

Copy this entire file to another LLM/dev. Goal: implement real authentication inside `authenticate()` in `middleware.ts` without changing the frontend contract.

---

## Stack

| Piece | Detail |
|--------|--------|
| Host | Vercel |
| Backend | **Single file:** `middleware.ts` (Vercel Edge Middleware) |
| Runtime | Edge (Web Fetch API, `crypto.subtle`, `process.env`) |
| Frontend | Static HTML/CSS/JS (`index.html`, `js/app.js`, `inbox.html`) |
| Package | `@vercel/edge` |

**Do not** add Express/Next API routes unless explicitly asked. Keep auth in `middleware.ts`.

---

## Project layout (relevant)

```
middleware.ts          ← ONLY backend file — edit authenticate() here
public/index.html      ← login page
public/js/app.js       ← POST /api/login client
public/inbox.html      ← post-login stub
public/assets/         ← logo, background, favicon
vercel.json            ← outputDirectory: public + /inbox rewrites
.env.local             ← secrets (not committed)
.env.example           ← template
```

Middleware matcher (already set):

```ts
export const config = {
  matcher: ["/api/:path*", "/inbox", "/inbox/:path*"],
};
```

---

## Env vars

| Name | Required | Purpose |
|------|----------|---------|
| `SESSION_SECRET` | **Yes** | HMAC secret for session cookie. Long random string. |
| `AUTH_URL` | Optional | Your upstream auth endpoint URL. Read inside `authenticate()`. |
| (any others) | Optional | Add as needed (`IMAP_HOST`, `API_KEY`, etc.) and read via `process.env`. |

Example `.env.local`:

```
SESSION_SECRET=replace-with-long-random-string
AUTH_URL=https://your-auth-service.example.com/login
```

On Vercel: Project Settings → Environment Variables. Same names.

---

## Frontend → backend contract (LOCKED — do not break)

### `POST /api/login`

**Request**

```http
POST /api/login
Content-Type: application/json
Accept: application/json
Credentials: same-origin

{
  "email": "user@bektel.com",
  "password": "secret"
}
```

**Server preprocessing (already done before `authenticate`)**

- `email` = `trim().toLowerCase()`
- Reject empty email/password → `400` `{ ok: false, error: "Email and password are required." }`
- Reject invalid email format → `400` `{ ok: false, error: "Please enter a valid email address." }`

**Success response** (middleware builds this after `authenticate` succeeds)

```http
HTTP 200
Content-Type: application/json
Set-Cookie: bektel_session=<token>; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax; Secure(prod only)

{
  "ok": true,
  "email": "user@bektel.com",
  "redirect": "/inbox"
}
```

Frontend then does: `window.location.assign(data.redirect || "/inbox")`.

**Failure response**

```http
HTTP 401
{
  "ok": false,
  "error": "Invalid email or password."
}
```

Frontend shows `data.error` in the red error line under the form.

---

### `POST /api/logout`

Clears `bektel_session` cookie.

```json
{ "ok": true }
```

---

### `GET /api/session`

Requires valid cookie.

**Authenticated**

```json
{
  "ok": true,
  "authenticated": true,
  "email": "user@bektel.com",
  "userId": "..."
}
```

**Unauthenticated** → `401`

```json
{ "ok": false, "authenticated": false }
```

---

### Route protection

- `/inbox` and `/inbox/*` require valid session cookie.
- Missing/invalid → `302` redirect to `/`.
- Rewrites: `/inbox` → `/inbox.html` (vercel.json).

---

## THE ONLY FUNCTION TO IMPLEMENT

File: `middleware.ts`  
Function: `authenticate(email: string, password: string)`

### Exact TypeScript contract

```ts
type AuthResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string };

async function authenticate(
  email: string,
  password: string
): Promise<AuthResult>
```

| Field | Rules |
|-------|--------|
| `email` input | Already trimmed + lowercased |
| `password` input | Raw string from client (not hashed yet) |
| Success `userId` | Any stable string ID from your backend |
| Success `email` | Canonical email to store in session (usually same as input) |
| Failure `error` | Human-readable string shown on the login form |

**Do not throw** for normal auth failures — return `{ ok: false, error: "..." }`.  
Throw/network errors: catch inside and return `{ ok: false, error: "..." }` or a generic message.

### Current stub (REPLACE THIS)

```ts
async function authenticate(
  email: string,
  password: string
): Promise<AuthResult> {
  if (!password) {
    return { ok: false, error: "Invalid email or password." };
  }
  return { ok: true, userId: email, email };
}
```

### Template for HTTP upstream auth

```ts
async function authenticate(
  email: string,
  password: string
): Promise<AuthResult> {
  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    return { ok: false, error: "Auth service is not configured." };
  }

  try {
    const res = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // "Authorization": `Bearer ${process.env.API_KEY}`,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      return { ok: false, error: "Invalid email or password." };
    }

    const data = await res.json();
    // Adjust field names to match YOUR API response:
    return {
      ok: true,
      userId: String(data.id ?? data.userId ?? email),
      email: String(data.email ?? email),
    };
  } catch {
    return { ok: false, error: "Unable to reach auth service. Please try again." };
  }
}
```

---

## Session (already implemented — don’t reinvent)

| Item | Value |
|------|--------|
| Cookie name | `bektel_session` |
| Format | `<base64url(JSON)>.<base64url(HMAC-SHA256)>` |
| Payload | `{ userId, email, exp }` — `exp` = unix seconds |
| Max age | `43200` (12 hours) |
| Flags | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production` |
| Signing | HMAC-SHA256 with `SESSION_SECRET` via `crypto.subtle` |

After successful `authenticate`, middleware creates the cookie and returns `{ ok, email, redirect }`. You do **not** set cookies inside `authenticate`.

---

## Edge runtime constraints

- No Node.js `fs`, `net`, native IMAP libs that need Node.
- Prefer `fetch()` to an external auth/API service.
- If you need IMAP/LDAP, put that on a separate server and call it via `AUTH_URL`.
- Keep cold-start small; avoid heavy deps in middleware.
- Timeouts: keep auth call fast (ideally &lt; 5s).

---

## Prompt for another LLM (paste this)

```
You are integrating real auth into BekTel webmail.

CONSTRAINTS:
- Edit ONLY the authenticate() function in middleware.ts (Vercel Edge Middleware).
- Do not change frontend (js/app.js) request/response shapes.
- authenticate(email, password) must return:
  - { ok: true, userId: string, email: string } on success
  - { ok: false, error: string } on failure
- email is already trim().toLowerCase()
- Use process.env.AUTH_URL (and any other env vars I provide)
- Edge runtime: use fetch + Web Crypto only; no Node-only modules
- On auth failure return ok:false; do not throw for bad passwords
- Do not set cookies in authenticate(); middleware already does that

FRONTEND CONTRACT:
POST /api/login JSON { email, password }
Success 200: { ok: true, email, redirect: "/inbox" } + Set-Cookie bektel_session
Failure 401: { ok: false, error: string }

MY AUTH BACKEND:
[DESCRIBE YOUR API HERE — URL, method, headers, request body, success JSON, error cases]

TASK:
Replace the stub authenticate() with correct code for my auth backend.
Return the full updated authenticate() function (and any tiny helpers if needed).
```

---

## Quick test checklist

1. Set `SESSION_SECRET` (+ `AUTH_URL` if used) in `.env.local` / Vercel.
2. `npm run dev` → open login page.
3. Bad password → red error from `error` field, stay on `/`.
4. Good password → cookie set, redirect `/inbox`, email shown.
5. Logout → cookie cleared, back to `/`.
6. Hit `/inbox` logged out → redirect `/`.

---

## Out of scope (unless asked)

- Building the full mail UI / IMAP sync
- Changing login UI look
- Adding more API routes outside middleware
- Changing cookie name or login JSON keys
