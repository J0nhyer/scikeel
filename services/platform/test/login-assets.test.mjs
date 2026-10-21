import test from 'node:test';
import assert from 'node:assert/strict';
import {loginAssetPreloads} from '../src/login-page.mjs';

test('login preloads the entry and its static imports without fetching optional routes',()=>{
 const manifest={'index.html':{file:'assets/app.js',isEntry:true,imports:['_react.js'],dynamicImports:['src/app/routes/NotebooksPage.tsx'],css:['assets/app.css']},
  '_react.js':{file:'assets/react.js'},'src/app/routes/NotebooksPage.tsx':{file:'assets/notebooks.js',css:['assets/notebooks.css']}};
 const links=loginAssetPreloads(manifest);
 assert.match(links,/href="\/assets\/app.js"/);assert.match(links,/href="\/assets\/react.js"/);
 assert.match(links,/href="\/assets\/app.css"/);assert.doesNotMatch(links,/notebooks/);
 assert.throws(()=>loginAssetPreloads({'index.html':{file:'../private',isEntry:true}}),/manifest/);
 assert.throws(()=>loginAssetPreloads({'index.html':{file:'assets/app.js',isEntry:true,imports:['missing']}}),/manifest/);
});
