import {createHash} from 'node:crypto';

// RTCM3 帧层：0xD3 前导、6 位保留位、10 位长度、payload、CRC24Q。
// 信任边界只有一条：完整帧头 + 有界长度 + CRC24Q 校验通过。
// 坏字节里的偶然 0xD3 不构成观测，只能作为候选重新尝试。

export const PREAMBLE = 0xD3;
export const MAX_PAYLOAD_LENGTH = 1023;
export const MAX_FRAME_LENGTH = 3 + MAX_PAYLOAD_LENGTH + 3;
// 缺陷记录的有界拆分：单条缺陷最多覆盖 4 个最大帧长，避免一次坏块产生无界记录。
export const MAX_DEFECT_SPAN = 4 * MAX_FRAME_LENGTH;

const CRC24Q_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 16;
  for (let bit = 0; bit < 8; bit++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864CFB; }
  CRC24Q_TABLE[i] = crc & 0xFFFFFF;
}

export function crc24q(buffer, start = 0, end = buffer.length) {
  let crc = 0;
  for (let index = start; index < end; index++) crc = ((crc << 8) ^ CRC24Q_TABLE[((crc >> 16) ^ buffer[index]) & 0xFF]) & 0xFFFFFF;
  return crc;
}

export function encodeFrame(payload) {
  const body = Buffer.from(payload);
  if (body.length > MAX_PAYLOAD_LENGTH) throw new Error('payload exceeds RTCM3 length budget');
  const frame = Buffer.alloc(3 + body.length + 3);
  frame[0] = PREAMBLE;
  frame[1] = (body.length >> 8) & 0x03;
  frame[2] = body.length & 0xFF;
  body.copy(frame, 3);
  frame.writeUIntBE(crc24q(frame, 0, 3 + body.length), 3 + body.length, 3);
  return frame;
}

export class BitReader {
  constructor(buffer) { this.buffer = buffer; this.bits = buffer.length * 8; }
  read(offset, length) {
    let value = 0;
    for (let index = 0; index < length; index++) value = value * 2 + ((this.buffer[(offset + index) >> 3] >> (7 - ((offset + index) & 7))) & 1);
    return value;
  }
  readSigned(offset, length) {
    const value = this.read(offset, length);
    return value >= 2 ** (length - 1) ? value - 2 ** length : value;
  }
}

function popcount32(value) {
  let n = value >>> 0;
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

export const MSM_CONSTELLATIONS = new Map([
  [107, {name: 'GPS', periodMs: 604800000, unit: 'ms-of-week'}],
  [108, {name: 'GLONASS', periodMs: 86400000, unit: 'ms-of-day'}],
  [109, {name: 'Galileo', periodMs: 604800000, unit: 'ms-of-week'}],
  [110, {name: 'SBAS', periodMs: 604800000, unit: 'ms-of-week'}],
  [111, {name: 'QZSS', periodMs: 604800000, unit: 'ms-of-week'}],
  [112, {name: 'BDS', periodMs: 604800000, unit: 'ms-of-week'}],
  [113, {name: 'NavIC', periodMs: 604800000, unit: 'ms-of-week'}]
]);

const TYPE_NAMES = new Map([
  [1005, 'station-arp'], [1006, 'station-arp-height'], [1007, 'antenna-descriptor'],
  [1008, 'antenna-descriptor-serial'], [1033, 'receiver-antenna-descriptor'], [1230, 'glonass-code-phase-bias']
]);

export function messageTypeName(type) {
  if (type === null || type === undefined) return 'unknown';
  const named = TYPE_NAMES.get(type);
  if (named) return named;
  const msm = MSM_CONSTELLATIONS.get(Math.floor(type / 10));
  if (msm && type % 10 >= 1 && type % 10 <= 7) return `${msm.name.toLowerCase()}-msm${type % 10}`;
  return `type-${type}`;
}

// 扫描一段连续字节流，返回 CRC 可信的帧和被跳过的缺陷区间。
// base 是该段在连接字节流中的绝对偏移；final=false 表示后面还会有字节（eof 未到）。
export function scanSegment(buffer, options = {}) {
  const base = options.base ?? 0;
  const final = options.final ?? true;
  const frames = [];
  const defects = [];
  let position = 0;
  let garbageStart = 0;
  let failures = 0;
  const declaredLengths = [];
  const garbageDefect = (start, end) => failures > 0
    ? {start: base + start, end: base + end, reason: 'crc-mismatch', failures, declaredLengths: declaredLengths.slice(0, 8)}
    : {start: base + start, end: base + end, reason: 'garbage'};
  const flushGarbage = (end) => {
    let start = garbageStart;
    while (end - start > MAX_DEFECT_SPAN) { defects.push(garbageDefect(start, start + MAX_DEFECT_SPAN)); start += MAX_DEFECT_SPAN; }
    if (end > start) defects.push(garbageDefect(start, end));
    failures = 0;
    declaredLengths.length = 0;
  };
  let incomplete = null;
  while (position + 3 <= buffer.length) {
    // 候选帧：前导 + 保留位为零 + 有界长度。不满足就逐字节前进，绝不臆造帧边界。
    if (buffer[position] !== PREAMBLE || (buffer[position + 1] & 0xFC) !== 0) { position++; continue; }
    const length = ((buffer[position + 1] & 0x03) << 8) | buffer[position + 2];
    const end = position + 3 + length + 3;
    if (end > buffer.length) { incomplete = {position, length}; break; }
    const expected = crc24q(buffer, position, end - 3);
    const actual = buffer.readUIntBE(end - 3, 3);
    if (expected !== actual) {
      // 校验失败：记录一次失败，从下一字节重新找帧；扫描范围受流长与候选长度约束。
      failures++;
      if (declaredLengths.length < 8) declaredLengths.push(length);
      position++;
      continue;
    }
    const skipped = position - garbageStart;
    if (skipped > 0) flushGarbage(position);
    frames.push({
      offset: base + position,
      length: end - position,
      type: length >= 2 ? (buffer[position + 3] << 4) | (buffer[position + 4] >> 4) : null,
      digest: createHash('sha256').update(buffer.subarray(position, end)).digest('hex').slice(0, 16),
      payload: buffer.subarray(position + 3, end - 3),
      recovered: skipped > 0
    });
    position = end;
    garbageStart = end;
  }
  if (incomplete) {
    if (incomplete.position > garbageStart) flushGarbage(incomplete.position);
    defects.push({start: base + incomplete.position, end: base + buffer.length, reason: final ? 'truncated-frame' : 'pending-tail', declaredLength: incomplete.length});
  } else if (final) {
    flushGarbage(buffer.length);
  } else {
    let partial = -1;
    for (let index = buffer.length - 1; index >= Math.max(garbageStart, buffer.length - 2); index--) {
      if (buffer[index] === PREAMBLE) { partial = index; break; }
    }
    if (partial >= 0) {
      if (partial > garbageStart) flushGarbage(partial);
      defects.push({start: base + partial, end: base + buffer.length, reason: 'pending-tail'});
    } else flushGarbage(buffer.length);
  }
  return {frames, defects};
}

function decodeStation(type, payload) {
  const reader = new BitReader(payload);
  const needed = type === 1006 ? 168 : 152;
  if (reader.bits < needed) return {kind: 'undecodable', reason: 'short-station-payload'};
  const decoded = {
    kind: 'station',
    messageType: type,
    station: reader.read(12, 12),
    coordinates: [reader.readSigned(34, 38) / 10000, reader.readSigned(74, 38) / 10000, reader.readSigned(114, 38) / 10000]
  };
  if (type === 1006) decoded.antennaHeight = reader.read(152, 16) / 10000;
  return decoded;
}

function decodeMsm(type, payload, constellation) {
  const reader = new BitReader(payload);
  if (reader.bits < 169) return {kind: 'undecodable', reason: 'short-msm-header'};
  const epochRaw = reader.read(24, 30);
  const satellites = popcount32(reader.read(73, 32)) + popcount32(reader.read(105, 32));
  const signals = popcount32(reader.read(137, 32));
  const cellBits = satellites * signals;
  const available = reader.bits - 169;
  let cells = 0;
  for (let index = 0; index < Math.min(cellBits, available); index++) cells += reader.read(169 + index, 1);
  const issues = [];
  if (cellBits > available) issues.push('cell-mask-truncated');
  const decoded = {
    kind: 'observation',
    constellation: constellation.name,
    periodMs: constellation.periodMs,
    unit: constellation.unit,
    msm: type % 10,
    station: reader.read(12, 12),
    multipleMessage: reader.read(54, 1) === 1,
    iods: reader.read(55, 3),
    satellites, signals, cells, issues
  };
  if (constellation.name === 'GLONASS') {
    decoded.dayOfWeek = epochRaw >> 27;
    decoded.epochMillis = epochRaw & 0x7FFFFFF;
  } else decoded.epochMillis = epochRaw;
  return decoded;
}

export function decodeMessage(type, payload) {
  if (type === null || type === undefined) return {kind: 'undecodable', reason: 'payload-too-short'};
  if (type === 1005 || type === 1006) return decodeStation(type, payload);
  const msm = MSM_CONSTELLATIONS.get(Math.floor(type / 10));
  if (msm && type % 10 >= 1 && type % 10 <= 7) return decodeMsm(type, payload, msm);
  return {kind: 'unknown'};
}
