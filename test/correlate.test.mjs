import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectSession} from '../src/reader.mjs';
import {correlate} from '../src/correlate.mjs';
import {encodeFrame} from '../src/rtcm3.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

// 位流拼装：[[值,位宽],...] → Buffer。值用除法取位，支持到 2^53。
function bits(fields) {
  const out = [];
  let acc = 0,width = 0;
  for (const [value,size] of fields) {
    for (let index = size - 1; index >= 0; index--) {
      acc = (acc << 1) | (Math.floor(value / 2 ** index) % 2);
      if (++width === 8) { out.push(acc); acc = 0; width = 0; }
    }
  }
  if (width > 0) out.push(acc << (8 - width));
  return Buffer.from(out);
}
const signed38 = value => value < 0 ? value + 2 ** 38 : value;
const stationFrame = (coordinates,station = 1) => encodeFrame(bits([
  [1005,12],[station,12],[0,6],[1,1],[0,1],[0,1],[0,1],
  [signed38(coordinates[0] * 10000),38],[0,1],[0,1],[signed38(coordinates[1] * 10000),38],[0,2],[signed38(coordinates[2] * 10000),38]
]));
const msmFrame = (tow,multiple,{type = 1077,station = 1,iods = 0} = {}) => encodeFrame(bits([
  [type,12],[station,12],[tow,30],[multiple ? 1 : 0,1],[iods,3],[0,7],[0,2],[0,2],[0,1],[0,3],[0,64],[0,32]
]));
function rowsFrom(connectionId,parts,mountpoint = 'LOCAL') {
  let offset = 0;
  return parts.map(part => {
    const buffer = Buffer.isBuffer(part) ? part : part.buffer;
    const at = Buffer.isBuffer(part) ? offset : (part.offset ?? offset);
    offset = at + buffer.length;
    return {id:`${connectionId}:${at}`,connectionId,mountpoint,offset:at,data:buffer.toString('base64'),bytes:buffer.length};
  });
}
const byKind = (records,kind) => records.filter(record => record.kind === kind);

test('正常场景：基站定义与历元关联，质量为 ok',async () => {
  const source = await createSource();
  try {
    const session = await collectSession(createClient(source.origin));
    const {records,summary} = correlate(session.rows,{mountpoint:session.mountpoint,eof:session.eof});
    assert.equal(summary.defects,0);
    assert.deepEqual(summary.quality,{ok:1,degraded:0,unknown:0});
    const station = byKind(records,'station')[0];
    assert.equal(station.id,'station:conn1:1:0');
    assert.deepEqual(station.coordinates,[1,2,3]);
    assert.equal(station.definedAt,0);
    const epoch = byKind(records,'epoch')[0];
    assert.equal(epoch.quality,'ok');
    assert.equal(epoch.complete,true);
    assert.deepEqual(epoch.issues,[]);
    assert.deepEqual(epoch.epoch,{period:0,millis:604799000,unit:'ms-of-week'});
    assert.deepEqual(epoch.station,{stationId:1,version:0,coordinates:[1,2,3],definedAt:0});
    assert.equal(epoch.messages.length,1);
    assert.equal(epoch.messages[0].type,1077);
    assert.equal(epoch.messages[0].offset,25);
    assert.deepEqual(epoch.origin,{connectionId:'conn1',mountpoint:'LOCAL',offsets:[25]});
  } finally {await source.close();}
});

test('分片加坏块：历元不假装正常，坏区间与原因留痕',async () => {
  const source = await createSource({scenario:'split-and-corrupt'});
  try {
    const session = await collectSession(createClient(source.origin));
    const {records,summary} = correlate(session.rows,{mountpoint:session.mountpoint,eof:session.eof});
    assert.deepEqual(summary.quality,{ok:0,degraded:1,unknown:0});
    const epoch = byKind(records,'epoch')[0];
    assert.equal(epoch.quality,'degraded');
    assert.ok(epoch.issues.includes('data-loss-in-window'));
    assert.equal(epoch.complete,true);
    assert.equal(epoch.messages[0].recovered,true);
    const defect = byKind(records,'defect')[0];
    assert.equal(defect.reason,'crc-mismatch');
    assert.deepEqual(defect.range,[25,31]);
    assert.equal(defect.bytes,6);
    assert.deepEqual(defect.origin,{connectionId:'conn1',mountpoint:'LOCAL',offsets:[25]});
  } finally {await source.close();}
});

test('站号相同不保证同一站：换挂载点后坐标与身份都分开',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const first = await collectSession(client);
    await client('/__scenario',{method:'POST',body:{name:'mountpoint-change'}});
    const second = await collectSession(client);
    const {records} = correlate([...first.rows,...second.rows],{eof:true});
    const stations = byKind(records,'station');
    assert.equal(stations.length,2);
    assert.ok(stations.every(station => station.stationId === 1));
    const byConn = Object.fromEntries(stations.map(station => [station.connectionId,station]));
    assert.deepEqual(byConn.conn1.coordinates,[1,2,3]);
    assert.deepEqual(byConn.conn2.coordinates,[4,2,3]);
    const epochs = byKind(records,'epoch');
    assert.equal(epochs.length,2);
    for (const epoch of epochs) {
      assert.equal(epoch.quality,'ok');
      assert.deepEqual(epoch.station.coordinates,byConn[epoch.connectionId].coordinates);
    }
  } finally {await source.close();}
});

test('跨周时间不按到达秒拼接：回滚后历元各自独立',() => {
  const rows = rowsFrom('connX',[stationFrame([1,2,3]),msmFrame(604799000,false),msmFrame(1000,false)]);
  const {records,summary} = correlate(rows,{eof:true});
  assert.deepEqual(summary.quality,{ok:2,degraded:0,unknown:0});
  const epochs = byKind(records,'epoch');
  assert.equal(epochs.length,2);
  const periods = Object.fromEntries(epochs.map(epoch => [epoch.epoch.millis,epoch.epoch.period]));
  assert.equal(periods[604799000],0);
  assert.equal(periods[1000],1);
  assert.ok(epochs.every(epoch => epoch.quality === 'ok'));
});

test('一个历元分几帧送完：multipleMessage 串起来才算完整',() => {
  const rows = rowsFrom('connX',[stationFrame([1,2,3]),msmFrame(5000,true),msmFrame(5000,false,{type:1074})]);
  const {records} = correlate(rows,{eof:true});
  const epochs = byKind(records,'epoch');
  assert.equal(epochs.length,1);
  assert.equal(epochs[0].complete,true);
  assert.deepEqual(epochs[0].messages.map(message => message.type),[1077,1074]);
  assert.equal(epochs[0].quality,'ok');
});

test('只有 multipleMessage 的半截历元标记为不完整',() => {
  const rows = rowsFrom('connX',[stationFrame([1,2,3]),msmFrame(5000,true)]);
  const {records} = correlate(rows,{eof:true});
  const epoch = byKind(records,'epoch')[0];
  assert.equal(epoch.complete,false);
  assert.ok(epoch.issues.includes('epoch-incomplete'));
  assert.equal(epoch.quality,'degraded');
});

test('乱序交织的帧按消息时间归组，不按到达顺序',() => {
  const rows = rowsFrom('connX',[stationFrame([1,2,3]),msmFrame(5000,true),msmFrame(6000,false),msmFrame(5000,false)]);
  const {records} = correlate(rows,{eof:true});
  const epochs = byKind(records,'epoch');
  assert.equal(epochs.length,2);
  const at = millis => epochs.find(epoch => epoch.epoch.millis === millis);
  assert.equal(at(5000).messages.length,2);
  assert.equal(at(5000).complete,true);
  assert.equal(at(6000).messages.length,1);
  assert.ok(epochs.every(epoch => epoch.quality === 'ok'));
});

test('重复帧与重复领取都幂等，只留注记不变相',() => {
  const stream = msmFrame(5000,false);
  const rows = rowsFrom('connX',[stationFrame([1,2,3]),stream,stream]);
  const {records} = correlate(rows,{eof:true});
  const epoch = byKind(records,'epoch')[0];
  assert.equal(epoch.messages.length,1);
  assert.equal(epoch.duplicates,1);
  assert.ok(epoch.notes.includes('duplicate-frames'));
  assert.equal(epoch.quality,'ok');
  // 同一原件行重复出现（重收）不产生缺陷也不产生重复。
  const again = correlate([...rows,...rows],{eof:true});
  assert.equal(byKind(again.records,'defect').length,0);
  assert.equal(byKind(again.records,'epoch')[0].duplicates,1);
});

test('没有基站定义的历元标为 unknown，保留原始领取位置',() => {
  const rows = rowsFrom('connX',[msmFrame(5000,false)]);
  const {records,summary} = correlate(rows,{eof:true});
  assert.deepEqual(summary.quality,{ok:0,degraded:0,unknown:1});
  const epoch = byKind(records,'epoch')[0];
  assert.equal(epoch.quality,'unknown');
  assert.equal(epoch.station,null);
  assert.ok(epoch.issues.includes('no-station-definition'));
  assert.deepEqual(epoch.origin.offsets,[0]);
});

test('字节缺口与冲突都留痕，缺口之后的历元降级',() => {
  const head = Buffer.concat([stationFrame([1,2,3]),msmFrame(5000,false)]);
  const tail = msmFrame(6000,false);
  const rows = rowsFrom('connX',[head,{buffer:tail,offset:head.length + 10}]);
  const {records} = correlate(rows,{eof:true});
  const gap = byKind(records,'defect').find(defect => defect.reason === 'byte-gap');
  assert.deepEqual(gap.range,[head.length,head.length + 10]);
  const epochs = byKind(records,'epoch');
  const at = millis => epochs.find(epoch => epoch.epoch.millis === millis);
  assert.equal(at(5000).quality,'ok');
  assert.equal(at(6000).quality,'degraded');
  assert.ok(at(6000).issues.includes('data-loss-in-window'));
  // 同一偏移内容冲突：保留先到字节并记录。
  const conflict = correlate([
    {id:'c:0',connectionId:'c',offset:0,data:stationFrame([1,2,3]).toString('base64'),bytes:25},
    {id:'c:0b',connectionId:'c',offset:0,data:stationFrame([9,9,9]).toString('base64'),bytes:25}
  ],{eof:true});
  assert.equal(byKind(conflict.records,'defect')[0].reason,'offset-conflict');
  assert.equal(byKind(conflict.records,'station')[0].coordinates[0],1);
});

test('同一连接内基站坐标变更产生新版本，历元各归各',() => {
  const rows = rowsFrom('connX',[stationFrame([1,2,3]),msmFrame(5000,false),stationFrame([4,2,3]),msmFrame(6000,false)]);
  const {records} = correlate(rows,{eof:true});
  const stations = byKind(records,'station');
  assert.equal(stations.length,2);
  assert.deepEqual(stations.map(station => station.version),[0,1]);
  const epochs = byKind(records,'epoch');
  const at = millis => epochs.find(epoch => epoch.epoch.millis === millis);
  assert.deepEqual(at(5000).station,{stationId:1,version:0,coordinates:[1,2,3],definedAt:0});
  assert.equal(at(6000).station.version,1);
  assert.ok(epochs.every(epoch => epoch.quality === 'ok'));
});

test('基站定义晚于历元到达时标注顺序异常，不冒充正常',() => {
  const rows = rowsFrom('connX',[msmFrame(5000,false),stationFrame([1,2,3])]);
  const {records} = correlate(rows,{eof:true});
  const epoch = byKind(records,'epoch')[0];
  assert.equal(epoch.quality,'degraded');
  assert.ok(epoch.issues.includes('station-defined-after-epoch'));
  assert.deepEqual(epoch.station.coordinates,[1,2,3]);
});

test('有效但不关联的帧与截断尾部都带原因留痕',() => {
  const aux = encodeFrame(bits([[1230,12],[1,12],[0,24]]));
  const partial = Buffer.from([0xD3,0x00,0x24,0x43,0x50]);
  const rows = rowsFrom('connX',[stationFrame([1,2,3]),msmFrame(5000,false),aux,partial]);
  const {records} = correlate(rows,{eof:true});
  const message = byKind(records,'message')[0];
  assert.equal(message.type,1230);
  assert.equal(message.reason,'unsupported-message-type');
  assert.equal(typeof message.offset,'number');
  const defect = byKind(records,'defect')[0];
  assert.equal(defect.reason,'truncated-frame');
  // 截断尾部在已完成历元之后，不回污染它。
  const epoch = byKind(records,'epoch')[0];
  assert.equal(epoch.quality,'ok');
});

test('关联记录可归档且幂等，查询服务暴露观测投影',async () => {
  const directory = await mkdtemp(join(tmpdir(),'correlate-'));
  try {
    const source = await createSource({scenario:'split-and-corrupt'});
    try {
      const session = await collectSession(createClient(source.origin));
      const {records} = correlate(session.rows,{mountpoint:session.mountpoint,eof:session.eof});
      const observations = new Archive(join(directory,'observations'));
      const first = await observations.put(records,{source:source.origin,adapter:'rtcm3-correlator'});
      const second = await observations.put(records,{source:source.origin,adapter:'rtcm3-correlator'});
      assert.equal(first.added,records.length);
      assert.equal(second.added,0);
      const api = await createApi(new Archive(join(directory,'raw')),0,{observations});
      try {
        const listed = await (await fetch(`${api.origin}/observations`)).json();
        assert.equal(listed.length,records.length);
        const epoch = listed.find(entry => entry.row.kind === 'epoch');
        assert.equal(epoch.row.quality,'degraded');
      } finally {await api.close();}
    } finally {await source.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
});
