// Pure cookie-jar functions (RFC 6265 subset). No browser APIs: runs in the service worker and in Node tests.
// A jar is a plain array of cookies; every function returns a new array and never mutates its input.
//
// Cookie shape: { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, expires, created }
//   expires: epoch ms, or null for a session cookie.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const parseUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const isLoopbackHost = (host) =>
  host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]';

const isIpHost = (host) => IPV4.test(host) || host.startsWith('[');

export const domainMatches = (host, domain) => host === domain || (!isIpHost(host) && host.endsWith(`.${domain}`));

export const pathMatches = (cookiePath, requestPath) =>
  requestPath === cookiePath ||
  (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));

const defaultPath = (pathname) => {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
};

// Parses one Set-Cookie header received from `requestUrl`. Returns null for anything the browser would reject.
export function parseSetCookie(header, requestUrl, now = Date.now()) {
  if (typeof header !== 'string') return null;
  const url = parseUrl(requestUrl);
  if (!url) return null;

  const [pair, ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  let domainAttr = null;
  let pathAttr = null;
  let maxAge = null;
  let expiresAttr = null;
  let secure = false;
  let httpOnly = false;
  let sameSite = null;

  for (const attribute of attributes) {
    const idx = attribute.indexOf('=');
    const key = (idx < 0 ? attribute : attribute.slice(0, idx)).trim().toLowerCase();
    const val = idx < 0 ? '' : attribute.slice(idx + 1).trim();
    if (key === 'domain' && val) domainAttr = val.replace(/^\./, '').toLowerCase();
    else if (key === 'path' && val.startsWith('/')) pathAttr = val;
    else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === 'expires') {
      const parsed = Date.parse(val);
      if (!Number.isNaN(parsed)) expiresAttr = parsed;
    } else if (key === 'secure') secure = true;
    else if (key === 'httponly') httpOnly = true;
    else if (key === 'samesite') sameSite = val.toLowerCase();
  }

  const host = url.hostname;
  if (domainAttr && !domainMatches(host, domainAttr)) return null;

  let expires = expiresAttr;
  if (maxAge !== null) expires = maxAge <= 0 ? 0 : now + maxAge * 1000;

  return {
    name,
    value,
    domain: domainAttr ?? host,
    hostOnly: !domainAttr,
    path: pathAttr ?? defaultPath(url.pathname),
    secure,
    httpOnly,
    sameSite,
    expires,
    created: now,
    updated: now,
  };
}

const sameIdentity = (a, b) => a.name === b.name && a.domain === b.domain && a.path === b.path;
const isExpired = (cookie, now) => cookie.expires !== null && cookie.expires <= now;

// Stores a parsed cookie. An already-expired cookie acts as a delete for the matching entry.
export function applySetCookie(jar, cookie, now = Date.now()) {
  if (!cookie) return jar;
  const existing = jar.find((c) => sameIdentity(c, cookie));
  const rest = jar.filter((c) => !sameIdentity(c, cookie));
  if (isExpired(cookie, now)) return rest;
  return [...rest, { ...cookie, created: existing?.created ?? cookie.created }];
}

export const purgeExpired = (jar, now = Date.now()) => jar.filter((c) => !isExpired(c, now));

// Would a browser send this cookie to a request for host/path?
const applies = (cookie, host, path, secureContext, now) =>
  !isExpired(cookie, now) &&
  (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)) &&
  pathMatches(cookie.path, path) &&
  (!cookie.secure || secureContext);

const requestContext = (url) => ({
  host: url.hostname,
  path: url.pathname || '/',
  secureContext: url.protocol === 'https:' || url.protocol === 'wss:' || isLoopbackHost(url.hostname),
});

// Marks every cookie that applies to `requestUrl` as recently used (`updated`). The engine evicts the least
// recently updated cookies first when the browser's rule limit is reached, so sites you actually use are kept.
export function touchCookies(jar, requestUrl, now = Date.now()) {
  const url = parseUrl(requestUrl);
  if (!url) return jar;
  const { host, path, secureContext } = requestContext(url);
  return jar.map((c) => (applies(c, host, path, secureContext, now) ? { ...c, updated: now } : c));
}

// Cookie header value: longer paths first, then oldest first (RFC 6265 5.4).
export const formatCookieHeader = (cookies) =>
  [...cookies]
    .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

// Value of the Cookie request header for `requestUrl`. includeHttpOnly=false gives the document.cookie view.
export function cookieHeaderFor(jar, requestUrl, now = Date.now(), { includeHttpOnly = true } = {}) {
  const url = parseUrl(requestUrl);
  if (!url) return '';
  const { host, path, secureContext } = requestContext(url);

  return formatCookieHeader(
    jar.filter((c) => applies(c, host, path, secureContext, now)).filter((c) => includeHttpOnly || !c.httpOnly),
  );
}
