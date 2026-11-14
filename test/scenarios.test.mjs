import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('split-and-corrupt');
await client('/connect',{method:'POST',body:{mountpoint:'LOCAL'}});
const chunks = (await client('/chunks?connection=conn1')).items;
assert.equal(Buffer.from(chunks[0].data,'base64').length,4);
assert.equal(chunks[1].byteOffset,4);
await choose('mountpoint-change');
assert.equal((await client('/connect',{method:'POST',body:{mountpoint:'LOCAL'}})).connectionId,'conn2');
} finally {await source.close();}
});
