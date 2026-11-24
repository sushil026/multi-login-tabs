// Turns profiles (cookie jar + tab ids) into declarativeNetRequest session rules. Pure: no browser APIs.
//
// For every profile with tabs:
//   1. base rule  (priority 1): strips the browser's real Cookie header and every Set-Cookie response header.
//                  Without it a profile tab on a site with no stored cookies would leak the real login.
//   2. frame rule (priority 1): appends `Server-Timing: mlx;desc="<profile>"` to page responses so the
//                  content script can read the profile id synchronously at document_start.
//   3. scope rules (priority > 1): one per distinct cookie scope (host x path x secure) plus the pairwise
//                  intersections of overlapping scopes. Each `set`s the Cookie header to exactly the cookies whose
//                  scope contains it. More specific scopes get a higher priority, so the right one wins.
//   4. snapshot rules (one per scope, page responses only): append `Server-Timing: mlxc;dur=<rank>;desc="<cookies>"`
//                  with the JavaScript-visible cookies, so the page shim can answer document.cookie synchronously.
import { domainMatches, formatCookieHeader, isLoopbackHost, pathMatches } from './cookie-jar.js';

export const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'other',
];

// The browser caps regex rules per extension (1000 in Brave/Chrome); every cookie scope costs one or two.
export const countRegexRules = (rules) => rules.filter((r) => r.condition.regexFilter).length;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_PATH_RANK = 5000;

// scope: { host, exact, path, secure }
const scopeOf = (cookie) => ({
  host: cookie.domain,
  exact: cookie.hostOnly,
  path: cookie.path,
  secure: cookie.secure && !isLoopbackHost(cookie.domain),
});

const scopeKey = (s) => `${s.exact ? '=' : '.'}${s.host}|${s.path}|${s.secure ? 's' : ''}`;

const hostContains = (outer, inner) => {
  if (outer.exact) return inner.exact && inner.host === outer.host;
  return inner.exact ? domainMatches(inner.host, outer.host) : inner.host === outer.host || inner.host.endsWith(`.${outer.host}`);
};

// outer matches every URL that inner matches
const contains = (outer, inner) =>
  hostContains(outer, inner) && pathMatches(outer.path, inner.path) && (!outer.secure || inner.secure);

function intersect(a, b) {
  let host;
  if (hostContains(a, b)) host = b;
  else if (hostContains(b, a)) host = a;
  else return null;

  let path;
  if (pathMatches(a.path, b.path)) path = b.path;
  else if (pathMatches(b.path, a.path)) path = a.path;
  else return null;

  return { host: host.host, exact: host.exact, path, secure: a.secure || b.secure };
}

function candidateScopes(cookies) {
  const unique = new Map();
  for (const cookie of cookies) {
    const scope = scopeOf(cookie);
    unique.set(scopeKey(scope), scope);
  }
  // Host, path and secure each narrow independently, so the most specific request scope can combine three cookies:
  // keep intersecting until nothing new appears (settles after at most a few rounds).
  let changed = true;
  while (changed) {
    changed = false;
    const current = [...unique.values()];
    for (let i = 0; i < current.length; i += 1) {
      for (let j = i + 1; j < current.length; j += 1) {
        const both = intersect(current[i], current[j]);
        if (both && !unique.has(scopeKey(both))) {
          unique.set(scopeKey(both), both);
          changed = true;
        }
      }
    }
  }
  return [...unique.values()];
}

// Strictly larger for any scope nested inside another: path dominates, then host specificity, then secure.
const scopePriority = (s) => {
  const hostRank = s.exact ? 500 : Math.min(s.host.length, 499);
  return 2 + Math.min(s.path.length, MAX_PATH_RANK) * 10_000 + hostRank * 10 + (s.secure ? 1 : 0);
};

function scopeRegex(s) {
  const schemes = s.secure ? '(https|wss)' : '(https?|wss?)';
  const host = s.exact ? escapeRegex(s.host) : `([^/:?#@]+\\.)?${escapeRegex(s.host)}`;
  let path;
  if (s.path === '/') path = '/';
  else if (s.path.endsWith('/')) path = escapeRegex(s.path);
  else path = `${escapeRegex(s.path)}([/?#]|$)`;
  return `^${schemes}://${host}(:[0-9]+)?${path}`;
}

function rulesForProfile({ jar, tabIds, id }, now) {
  const live = jar.filter((c) => c.expires === null || c.expires > now);
  const rules = [
    {
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }],
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
      },
      condition: { tabIds, resourceTypes: RESOURCE_TYPES },
    },
    {
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'server-timing', operation: 'append', value: `mlx;desc="${id}"` }],
      },
      condition: { tabIds, resourceTypes: ['main_frame', 'sub_frame'] },
    },
  ];

  for (const scope of candidateScopes(live)) {
    const members = live.filter((c) => contains(scopeOf(c), scope));
    const value = formatCookieHeader(members);
    if (!value) continue;
    const priority = scopePriority(scope);
    const regexFilter = scopeRegex(scope);
    rules.push({
      priority,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set', value }] },
      condition: { tabIds, regexFilter, isUrlFilterCaseSensitive: true, resourceTypes: RESOURCE_TYPES },
    });

    // Snapshot of what document.cookie shows for pages in this scope (httpOnly excluded, as in a browser). The page
    // shim reads it synchronously at document_start. Several scopes can match one page; the shim keeps the entry
    // with the highest `dur`, which is the most specific scope and therefore the complete set (see candidateScopes).
    const documentValue = formatCookieHeader(members.filter((c) => !c.httpOnly));
    if (documentValue) {
      rules.push({
        priority,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'server-timing', operation: 'append', value: `mlxc;dur=${priority};desc="${encodeURIComponent(documentValue)}"` },
          ],
        },
        condition: { tabIds, regexFilter, isUrlFilterCaseSensitive: true, resourceTypes: ['main_frame', 'sub_frame'] },
      });
    }
  }
  return rules;
}

// profiles: [{ id, jar, tabIds }] -> DNR rules with unique sequential ids starting at 1.
export function buildRules(profiles, now = Date.now()) {
  return profiles
    .filter((p) => p.tabIds.length > 0)
    .flatMap((p) => rulesForProfile(p, now))
    .map((rule, index) => ({ id: index + 1, ...rule }));
}
