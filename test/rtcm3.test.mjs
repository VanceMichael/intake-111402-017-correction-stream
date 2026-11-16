import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {crc24q,encodeFrame,scanSegment,decodeMessage,MAX_DEFECT_SPAN} from '../src/rtcm3.mjs';

const decoded = JSON.parse(await readFile(new URL('../fixtures/decoded.json',import.meta.url),'utf8'));
const source = JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));
const scenarioBody = name => name === 'normal'
  ? source.exchanges.find(route => route.path === '/chunks').body
  : source.cases[name].find(route => route.path === '/chunks').body;
const scenarioStream = name => Buffer.concat(scenarioBody(name).items.map(item => Buffer.from(item.data,'base64')));

test('CRC24Q 与逐位参考值一致',() => {
  // CRC-24Q（poly 0x1864CFB，init 0）对 "123456789" 的校验值为 0xCDE703。
  assert.equal(crc24q(Buffer.from('123456789','ascii')),0xCDE703);
});

test('正常场景两帧全部通过校验，字段与对照资料一致',() => {
  const {frames,defects} = scanSegment(scenarioStream('normal'),{final:true});
  assert.equal(defects.length,0);
  assert.deepEqual(frames.map(frame => frame.offset),[0,25]);
  assert.deepEqual(frames.map(frame => frame.type),[1005,1077]);
  const station = decodeMessage(frames[0].type,frames[0].payload);
  assert.equal(station.kind,'station');
  assert.equal(station.station,decoded.frames[0].station);
  assert.deepEqual(station.coordinates,decoded.frames[0].coordinates);
  const msm = decodeMessage(frames[1].type,frames[1].payload);
  assert.equal(msm.kind,'observation');
  assert.equal(msm.station,decoded.frames[1].station);
  assert.equal(msm.epochMillis,decoded.frames[1].epoch);
  assert.equal(msm.multipleMessage,decoded.frames[1].multipleMessage);
  assert.equal(msm.iods,decoded.frames[1].issueOfDataStation);
});

test('帧被分片送达时按字节偏移重组后再校验',() => {
  const body = scenarioBody('split-and-corrupt');
  const first = Buffer.from(body.items[0].data,'base64');
  assert.equal(first.length,4);
  // 只有前 4 字节时不能出帧：候选帧声明 19 字节 payload，只能记为截断。
  const partial = scanSegment(first,{final:true});
  assert.equal(partial.frames.length,0);
  assert.equal(partial.defects[0].reason,'truncated-frame');
  // 拼上后续字节后 1005 完整恢复。
  const {frames} = scanSegment(scenarioStream('split-and-corrupt'),{final:true});
  assert.equal(frames[0].type,1005);
  assert.equal(frames[0].offset,0);
});

test('校验失败在有界范围内重找帧，坏字节被记录而不是被信任',() => {
  const {frames,defects} = scanSegment(scenarioStream('split-and-corrupt'),{final:true});
  assert.deepEqual(frames.map(frame => frame.offset),[0,31]);
  assert.equal(frames[1].recovered,true);
  assert.equal(defects.length,1);
  assert.equal(defects[0].reason,'crc-mismatch');
  assert.deepEqual([defects[0].start,defects[0].end],[25,31]);
  assert.equal(defects[0].failures,1);
  assert.deepEqual(defects[0].declaredLengths,[1]);
});

test('坏字节里的偶然前导不产生观测',() => {
  // "bad" 帧：前导 + 长度 1 + 伪 CRC，后面再跟一个偶然 0xD3，两者都不能成帧。
  const garbage = Buffer.from([0xD3,0x00,0x01,0x62,0x61,0x64,0x00,0xD3,0x04,0x00,0x11,0x22,0x33]);
  const {frames,defects} = scanSegment(garbage,{final:true});
  assert.equal(frames.length,0);
  assert.ok(defects.length >= 1);
  assert.equal(defects[0].reason,'crc-mismatch');
  // 保留位非零的 0xD3 连候选都不是。
  const reserved = Buffer.from([0xD3,0xFC,0x00,0x01,0x02]);
  assert.equal(scanSegment(reserved,{final:true}).frames.length,0);
});

test('垃圾区间记录有界拆分，不吞字节也不产生无界记录',() => {
  const garbage = Buffer.alloc(MAX_DEFECT_SPAN * 2 + 100,0xAB);
  const {frames,defects} = scanSegment(garbage,{final:true});
  assert.equal(frames.length,0);
  assert.equal(defects.length,3);
  assert.ok(defects.every(defect => defect.reason === 'garbage' && defect.end - defect.start <= MAX_DEFECT_SPAN));
  assert.equal(defects.at(-1).end,garbage.length);
});

test('截断尾部按 eof 区分 truncated 与 pending',() => {
  const frame = encodeFrame(Buffer.from([0x43,0x50,0x01]));
  const stream = Buffer.concat([frame,Buffer.from([0xD3,0x00,0x13,0x3E,0xD0])]);
  const done = scanSegment(stream,{final:true});
  assert.equal(done.frames.length,1);
  assert.equal(done.defects.at(-1).reason,'truncated-frame');
  assert.equal(done.defects.at(-1).declaredLength,19);
  const waiting = scanSegment(stream,{final:false});
  assert.equal(waiting.defects.at(-1).reason,'pending-tail');
});

test('encodeFrame 与扫描器往返一致，篡改必被校验发现',() => {
  const payload = Buffer.from([0x3E,0xD0,0x01,0x02,0x03]);
  const frame = encodeFrame(payload);
  const {frames,defects} = scanSegment(frame,{final:true});
  assert.equal(frames.length,1);
  assert.equal(defects.length,0);
  assert.equal(frames[0].type,(0x3E << 4) | (0xD0 >> 4));
  const tampered = Buffer.from(frame);
  tampered[5] ^= 0x01;
  const result = scanSegment(tampered,{final:true});
  assert.equal(result.frames.length,0);
  assert.equal(result.defects[0].reason,'crc-mismatch');
});
