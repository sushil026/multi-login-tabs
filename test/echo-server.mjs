// Test server. /echo returns the Cookie header it received and rotates a cookie on every call.
// /blank sets nothing (used to get a tab id without touching the cookie store).
// /storage is a page that writes and reads localStorage keyed by ?who=.
import http from 'node:http';

export async function startEchoServer(port = 0) {
  let rotation = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/echo') {
      rotation += 1;
      res.setHeader('Set-Cookie', [`rot=${rotation}; Path=/; HttpOnly`]);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? '', rotation }));
      return;
    }
    if (url.pathname === '/login') {
      // Simulates a login: an httpOnly session cookie named after the user.
      res.setHeader('Set-Cookie', [`sid=${url.searchParams.get('user')}; Path=/; HttpOnly`]);
      res.setHeader('Content-Type', 'text/plain');
      res.end('logged in');
      return;
    }
    if (url.pathname === '/jscookie') {
      // A cookie script is allowed to read (no HttpOnly), like a CSRF token.
      res.setHeader('Set-Cookie', [`${url.searchParams.get('name') ?? 'theme'}=${url.searchParams.get('value') ?? 'dark'}; Path=/`]);
      res.setHeader('Content-Type', 'text/plain');
      res.end('ok');
      return;
    }
    if (url.pathname === '/cookiefirst') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>c</title><body><script>
        document.documentElement.dataset.cookieAtFirst = document.cookie;
      </script></body>`);
      return;
    }
    if (url.pathname === '/storage') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>storage</title><body><script>
        const who = ${JSON.stringify(url.searchParams.get('who') ?? '')};
        if (who) localStorage.setItem('who', who);
        document.body.textContent = JSON.stringify({ who: localStorage.getItem('who'), cookie: document.cookie });
      </script></body>`);
      return;
    }
    if (url.pathname === '/probe') {
      // First inline script of the page: what profile id was already visible?
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>probe</title><body><script>
        document.documentElement.dataset.atFirst = String(window.__mlxProfile);
      </script></body>`);
      return;
    }
    if (url.pathname === '/frame') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>frame</title><body><iframe id="f" src="/probe"></iframe></body>');
      return;
    }
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(port, resolve));
  const { port: actual } = server.address();
  return { server, port: actual, base: `http://localhost:${actual}` };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}`) {
  const { base } = await startEchoServer(4789);
  console.log(`echo server at ${base}`);
}
