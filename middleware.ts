/**
 * BekTel webmail — single Vercel Edge backend (middleware).
 *
 * Handles:
 *   POST /api/login   → authenticate, set session cookie, return redirect
 *   POST /api/logout  → clear session
 *   GET  /api/session → current session status
 *
 * Wire real auth in `authenticate()` (IMAP / SSO / your API).
 */

import { next } from "@vercel/edge";

export const config = {
  matcher: ["/api/:path*", "/inbox", "/inbox/:path*"],
};

type LoginBody = {
  email?: string;
  password?: string;
};

type AuthResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string };

type SessionPayload = {
  userId: string;
  email: string;
  exp: number;
};

const SESSION_COOKIE = "bektel_session";
const SESSION_MAX_AGE = 60 * 60 * 12; // 12 hours

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/api/login" && request.method === "POST") {
    return handleLogin(request);
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    return handleLogout();
  }

  if (pathname === "/api/session" && request.method === "GET") {
    return handleSession(request);
  }

  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) {
    const session = await verifySession(request);
    if (!session) {
      return Response.redirect(new URL("/", request.url), 302);
    }
    return next();
  }

  if (pathname.startsWith("/api/")) {
    return json({ ok: false, error: "Not found" }, 404);
  }

  return next();
}

async function handleLogin(request: Request): Promise<Response> {
  let body: LoginBody;

  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return json({ ok: false, error: "Email and password are required." }, 400);
  }

  if (!isValidEmail(email)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400);
  }

  const auth = await authenticate(email, password);

  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, 401);
  }

  const token = await createSessionToken({
    userId: auth.userId,
    email: auth.email,
  });

  const response = json({
    ok: true,
    email: auth.email,
    redirect: "/inbox",
  });

  response.headers.append(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, token, cookieOpts(SESSION_MAX_AGE))
  );

  return response;
}

function handleLogout(): Response {
  const response = json({ ok: true });
  response.headers.append(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, "", cookieOpts(0))
  );
  return response;
}

function cookieOpts(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

async function handleSession(request: Request): Promise<Response> {
  const session = await verifySession(request);
  if (!session) {
    return json({ ok: false, authenticated: false }, 401);
  }
  return json({
    ok: true,
    authenticated: true,
    email: session.email,
    userId: session.userId,
  });
}

/**
 * Plug in your real auth here (IMAP, LDAP, SSO, internal API, etc.).
 * Stub accepts any non-empty credentials — replace before production.
 */
async function authenticate(
  email: string,
  password: string
): Promise<AuthResult> {
  // --- BACKEND INTEGRATION POINT ---
  // const res = await fetch(process.env.AUTH_URL!, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ email, password }),
  // });
  // if (!res.ok) return { ok: false, error: "Invalid email or password." };
  // const data = await res.json();
  // return { ok: true, userId: data.id, email: data.email };

  if (!password) {
    return { ok: false, error: "Invalid email or password." };
  }

  return { ok: true, userId: email, email };
}

async function createSessionToken(
  data: Omit<SessionPayload, "exp">
): Promise<string> {
  const payload: SessionPayload = {
    ...data,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = await hmacSign(body, getSecret());
  return `${body}.${sig}`;
}

async function verifySession(
  request: Request
): Promise<SessionPayload | null> {
  const cookie = parseCookies(request.headers.get("cookie") || "");
  const raw = cookie[SESSION_COOKIE];
  if (!raw) return null;

  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;

  const expected = await hmacSign(body, getSecret());
  if (sig !== expected) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(body)) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function getSecret(): string {
  return process.env.SESSION_SECRET || "bektel-dev-secret-change-me";
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function serializeCookie(
  name: string,
  value: string,
  opts: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    path?: string;
    maxAge?: number;
  }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

function base64UrlEncode(str: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}
