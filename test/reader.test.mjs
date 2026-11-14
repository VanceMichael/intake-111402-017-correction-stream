import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('字节位置属于连接而不是挂载点名称', async () => {
  const rows = await collect(client);
  assert.equal(rows[0].connectionId, 'conn1');
  assert.equal(rows[0].offset, 0);
  assert.ok(rows[0].bytes > 6);
});
