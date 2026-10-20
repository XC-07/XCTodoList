// 零依赖本地预览服务：node server.js 后访问 http://localhost:8321
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8321;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not Found");
      }
      res.writeHead(200, {
        "Content-Type":
          MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`预览服务已启动: http://localhost:${PORT}`);
  });
