const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const converter=require('./converter-server').createConverter(root);
const audioSeparator=require('./audio-separator-server').createAudioSeparator(root);
const port = Number(process.env.PORT || 8765);
const mime = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};

http.createServer(async (req,res) => {
  let url;try{url=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end('Bad request')}
  if(await audioSeparator(req,res,url))return;
  if(await converter(req,res,url))return;
  let pathname;try{pathname=decodeURIComponent(url.pathname)}catch{res.writeHead(400);return res.end('Bad request')}
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(root,name);
  if (!file.startsWith(root + path.sep) || !(['index.html','chroma-key.js','app.js','style.css','lame.min.js','guide.html','converter.html','converter.js','converter.css','slow-motion.html','slow-motion.js'].includes(name)||/^guide-assets\/[a-z0-9-]+\.(png|svg)$/.test(name))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file,(err,data) => {
    if(err){res.writeHead(404);return res.end('Not found')}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
}).listen(port,'127.0.0.1',() => {
  console.log(`Редактор: http://localhost:${port}`);
  console.log('Сеть Интернет не требуется. Для остановки нажмите Ctrl+C.');
});
