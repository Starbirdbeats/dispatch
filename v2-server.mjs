// Isolated frontend flow preview. No provider access, shell execution, or v1 data writes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'v2');
const port = Number(process.env.DISPATCH_V2_PORT || 4420);
const assets = new Map(['index.html','studio.css','studio.js','model.mjs'].map(name=>['/v2/'+name,name]));
assets.set('/','index.html'); assets.set('/v2/','index.html');
http.createServer((req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  const name=assets.get(new URL(req.url,'http://localhost').pathname);
  if(!name){res.writeHead(404);res.end('Not found');return;}
  res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
  res.end(req.method==='HEAD'?undefined:fs.readFileSync(path.join(root,name)));
}).listen(port,process.env.DISPATCH_V2_HOST || '127.0.0.1',()=>console.log(`Dispatch v2 test-mode frontend listening on port ${port}`));
