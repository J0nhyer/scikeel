import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogQuery} from '../src/catalog-query.mjs';

const params=entries=>new URLSearchParams(entries);
const rejects=(path,entries,code='invalid_catalog_query')=>
 assert.throws(()=>catalogQuery(path,params(entries)),{code,statusCode:400});

test('bootstrap accepts only the page limit',()=>{
 assert.deepEqual(catalogQuery('/api/workspace/bootstrap',params([['limit','50']])),{limit:50});
 rejects('/api/workspace/bootstrap',[['search','eeg']]);
});

test('conversations accept and normalize the new filters',()=>{
 assert.deepEqual(
  catalogQuery('/api/workspace/catalog/conversations',params([
   ['limit','20'],['cursor','abc'],['search','eeg'],['projectId','project_a'],
   ['lifecycle','any'],
  ])),
  {limit:20,cursor:'abc',search:'eeg',projectId:'project_a',lifecycle:'any'},
 );
 assert.deepEqual(
  catalogQuery('/api/workspace/catalog/conversations',params([['unassigned','1']])),
  {unassigned:true},
 );
 rejects('/api/workspace/catalog/conversations',[['unassigned','0']]);
 rejects('/api/workspace/catalog/conversations',[['projectId','p'],['unassigned','1']]);
 rejects('/api/workspace/catalog/conversations',[['lifecycle','paused']]);
 rejects('/api/workspace/catalog/conversations',[['search','x'.repeat(513)]]);
 rejects('/api/workspace/catalog/conversations',[['limit','0']]);
 rejects('/api/workspace/catalog/conversations',[['limit','1'],['limit','2']]);
 rejects('/api/workspace/catalog/conversations',[['unknown','1']]);
});

test('projects reject conversation-only filters and project-counts takes no query',()=>{
 rejects('/api/workspace/catalog/projects',[['search','eeg']]);
 rejects('/api/workspace/catalog/projects',[['lifecycle','any']]);
 rejects('/api/workspace/catalog/project-counts',[['limit','1']]);
});
