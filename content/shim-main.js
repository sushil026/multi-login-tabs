// Page-side shim. Runs in the page's own JavaScript world at document_start, in every frame.
// It does NOTHING unless this page belongs to a profile tab, so ordinary tabs are never touched.
//
// How it knows: the per-tab DNR rules append Server-Timing entries to page responses, and the navigation entry
// exposes them synchronously, before any site script runs:
//   mlx;desc="<profile id>"                      which profile this tab belongs to
//   mlxc;dur=<rank>;desc="<encoded cookies>"     the JavaScript-visible cookies for this page (highest rank wins)
//
// What it isolates per profile on a shared origin (cookies on the wire are handled by the DNR rules instead):
//   localStorage   keys get a profile prefix                 (sessionStorage is already per tab: left alone)
//   IndexedDB      database names get a profile prefix
//   document.cookie  answered from a mirror of the profile's jar; writes are forwarded to the background worker
(() => {
  'use strict';

  const timings = performance.getEntriesByType('navigation')[0]?.serverTiming ?? [];
  const profile = timings.find((t) => t.name === 'mlx')?.description;
  if (!profile) return;

  const PREFIX = `__mlx_${profile}__`;
  const isMine = (key) => key.startsWith(PREFIX);

  // ---- localStorage ---------------------------------------------------------------------------------------
  const patchLocalStorage = () => {
    let real;
    try {
      real = window.localStorage;
    } catch {
      return; // storage blocked for this frame (sandboxed iframe): nothing to isolate
    }
    if (!real) return;

    const proto = Storage.prototype;
    const native = {
      get: proto.getItem,
      set: proto.setItem,
      remove: proto.removeItem,
      key: proto.key,
      clear: proto.clear,
      length: Object.getOwnPropertyDescriptor(proto, 'length').get,
    };
    let wrapped;
    const unwrap = (storage) => (storage === wrapped ? real : storage);
    const isLocal = (storage) => unwrap(storage) === real;
    const ownKeys = () => {
      const keys = [];
      const count = native.length.call(real);
      for (let i = 0; i < count; i += 1) {
        const key = native.key.call(real, i);
        if (key !== null && isMine(key)) keys.push(key);
      }
      return keys;
    };

    // Patch the prototype too, so Storage.prototype.getItem.call(localStorage, ...) behaves.
    proto.getItem = function getItem(...args) {
      return isLocal(this) && args.length ? native.get.call(real, PREFIX + args[0]) : native.get.apply(unwrap(this), args);
    };
    proto.setItem = function setItem(...args) {
      return isLocal(this) && args.length >= 2
        ? native.set.call(real, PREFIX + args[0], args[1])
        : native.set.apply(unwrap(this), args);
    };
    proto.removeItem = function removeItem(...args) {
      return isLocal(this) && args.length ? native.remove.call(real, PREFIX + args[0]) : native.remove.apply(unwrap(this), args);
    };
    proto.key = function key(...args) {
      if (!isLocal(this) || !args.length) return native.key.apply(unwrap(this), args);
      return ownKeys()[Number(args[0])]?.slice(PREFIX.length) ?? null;
    };
    proto.clear = function clear() {
      if (!isLocal(this)) return native.clear.call(unwrap(this));
      for (const key of ownKeys()) native.remove.call(real, key);
      return undefined;
    };
    Object.defineProperty(proto, 'length', {
      get() {
        return isLocal(this) ? ownKeys().length : native.length.call(unwrap(this));
      },
      enumerable: true,
      configurable: true,
    });

    const namedKey = (prop) => typeof prop === 'string' && !(prop in proto);
    wrapped = new Proxy(real, {
      get(_target, prop) {
        if (!namedKey(prop)) return Reflect.get(proto, prop, wrapped);
        const value = native.get.call(real, PREFIX + prop);
        return value === null ? undefined : value;
      },
      set(_target, prop, value) {
        if (!namedKey(prop)) return false;
        native.set.call(real, PREFIX + prop, value);
        return true;
      },
      deleteProperty(_target, prop) {
        if (namedKey(prop)) native.remove.call(real, PREFIX + prop);
        return true;
      },
      has(_target, prop) {
        return !namedKey(prop) || native.get.call(real, PREFIX + prop) !== null;
      },
      ownKeys() {
        return ownKeys().map((key) => key.slice(PREFIX.length));
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (!namedKey(prop)) return undefined;
        const value = native.get.call(real, PREFIX + prop);
        return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(_target, prop, descriptor) {
        if (!namedKey(prop) || !('value' in descriptor)) return false;
        native.set.call(real, PREFIX + prop, descriptor.value);
        return true;
      },
    });
    Object.defineProperty(window, 'localStorage', { get: () => wrapped, enumerable: true, configurable: true });

    // 'storage' events come from every tab of the origin. Drop other profiles' events, strip the prefix from ours.
    window.addEventListener(
      'storage',
      (event) => {
        if (event.storageArea !== real) return;
        if (event.key !== null) {
          if (!isMine(event.key)) {
            event.stopImmediatePropagation();
            return;
          }
          Object.defineProperty(event, 'key', { value: event.key.slice(PREFIX.length) });
        }
        Object.defineProperty(event, 'storageArea', { value: wrapped });
      },
      true,
    );
  };

  // ---- IndexedDB ------------------------------------------------------------------------------------------
  const patchIndexedDb = () => {
    if (typeof IDBFactory === 'undefined') return;
    const proto = IDBFactory.prototype;
    const { open, deleteDatabase, databases } = proto;
    proto.open = function patchedOpen(...args) {
      return args.length ? open.call(this, PREFIX + args[0], ...args.slice(1)) : open.call(this);
    };
    proto.deleteDatabase = function patchedDelete(...args) {
      return args.length ? deleteDatabase.call(this, PREFIX + args[0]) : deleteDatabase.call(this);
    };
    if (databases) {
      proto.databases = function patchedDatabases() {
        return databases
          .call(this)
          .then((all) => all.filter((db) => db.name && isMine(db.name)).map((db) => ({ ...db, name: db.name.slice(PREFIX.length) })));
      };
    }
    const nameDescriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
    Object.defineProperty(IDBDatabase.prototype, 'name', {
      ...nameDescriptor,
      get() {
        const name = nameDescriptor.get.call(this);
        return isMine(name) ? name.slice(PREFIX.length) : name;
      },
    });
  };

  // ---- document.cookie ------------------------------------------------------------------------------------
  const patchCookies = () => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (!descriptor?.configurable) return;

    const host = location.hostname;
    const secureContext =
      location.protocol === 'https:' || host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d+){3}$/.test(host) || host === '[::1]';
    const splitPair = (text) => {
      const eq = text.indexOf('=');
      return eq < 0 ? ['', text.trim()] : [text.slice(0, eq).trim(), text.slice(eq + 1).trim()];
    };

    const mirror = new Map();
    const load = (text) => {
      mirror.clear();
      for (const part of text.split('; ')) {
        if (!part) continue;
        const [name, value] = splitPair(part);
        mirror.set(name, value);
      }
    };
    const render = () => [...mirror].map(([name, value]) => (name === '' ? value : `${name}=${value}`)).join('; ');

    const decode = (text) => {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    };
    const snapshot = timings.filter((t) => t.name === 'mlxc').sort((a, b) => b.duration - a.duration)[0];
    load(snapshot ? decode(snapshot.description) : '');

    const write = (text) => {
      const [pair, ...attributes] = text.split(';');
      const [name, value] = splitPair(pair);
      let expired = false;
      let ignored = false;
      let hasMaxAge = false;
      for (const attribute of attributes) {
        // Flags such as HttpOnly have no "=": the whole text is the attribute name.
        const eq = attribute.indexOf('=');
        const lower = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
        const raw = eq < 0 ? '' : attribute.slice(eq + 1).trim();
        if (lower === 'httponly') ignored = true; // browsers refuse httpOnly cookies from script
        else if (lower === 'secure' && !secureContext) ignored = true;
        else if (lower === 'max-age' && /^-?\d+$/.test(raw)) {
          hasMaxAge = true;
          expired = Number(raw) <= 0;
        } else if (lower === 'expires' && !hasMaxAge) {
          const time = Date.parse(raw);
          if (!Number.isNaN(time)) expired = time <= Date.now();
        } else if (lower === 'domain') {
          const domain = raw.replace(/^\./, '').toLowerCase();
          if (domain && host !== domain && !host.endsWith(`.${domain}`)) ignored = true;
        }
      }
      if (ignored) return;
      if (expired) mirror.delete(name);
      else mirror.set(name, value);
      window.dispatchEvent(new CustomEvent('__mlx_cookie_set', { detail: text })); // the bridge forwards it
    };

    // Cookies that change while the page is open (Set-Cookie on fetch responses, other tabs of this profile).
    window.addEventListener('__mlx_cookies', (event) => load(String(event.detail ?? '')));

    Object.defineProperty(Document.prototype, 'cookie', {
      get() {
        return this === document ? render() : descriptor.get.call(this);
      },
      set(value) {
        if (this === document) write(String(value));
        else descriptor.set.call(this, value);
      },
      enumerable: descriptor.enumerable,
      configurable: true,
    });
  };

  for (const patch of [patchLocalStorage, patchIndexedDb, patchCookies]) {
    try {
      patch();
    } catch {
      // never let isolation code break the page
    }
  }
})();
