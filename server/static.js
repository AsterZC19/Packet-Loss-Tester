// server/static.js
// Minimal, dependency-free static file server for the public/ directory.
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function serveStatic(publicDir) {
  const root = path.resolve(publicDir);

  return function handleStatic(req, res, url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    // Resolve against the public root and guard against path traversal.
    const safePath = path.resolve(root, '.' + pathname);
    if (safePath !== root && !safePath.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    let filePath = safePath;
    if (pathname.endsWith('/')) {
      filePath = path.join(safePath, 'index.html');
    } else if (!path.extname(filePath)) {
      // Bare path like /about -> try /about/index.html
      filePath = path.join(safePath, 'index.html');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // Fall back to index.html (SPA-style) if it's not the root file itself.
        if (path.extname(pathname) === '') {
          return fs.readFile(path.join(root, 'index.html'), (err2, index) => {
            if (err2) return send404(res);
            send(res, index, 'text/html; charset=utf-8');
          });
        }
        return send404(res);
      }
      const ext = path.extname(filePath).toLowerCase();
      send(res, data, MIME[ext] || 'application/octet-stream');
    });
  };
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function send(res, data, contentType) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}
