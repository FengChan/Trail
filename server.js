/* 极简本地静态服务：仅用于把页面以 http://127.0.0.1 方式打开
 * 说明：这不是后端，没有任何接口、数据库和数据存储，
 * 只做「把 index.html / app.js / styles.css 发给浏览器」这一件事。
 * 之所以需要它：浏览器只对 http(s) 页面开放「记住并直连本地文件」的权限，
 * 双击 index.html（file:// 方式）时该能力被浏览器禁用。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {            // 防目录穿越
    res.writeHead(403); return res.end('forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    // no-store：本地工具文件随时在改，禁止浏览器用旧缓存
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('事项追踪已启动，浏览器打开： http://127.0.0.1:' + PORT);
  console.log('（关闭本窗口即停止服务）');
});
