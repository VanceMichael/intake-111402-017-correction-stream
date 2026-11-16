import {scanSegment, decodeMessage, messageTypeName} from './rtcm3.mjs';

// 关联层：把同一连接内的可信帧组装成基站定义与观测历元。
// 站身份 = 连接 + 站号 + 坐标版本；跨挂载点/重连后站号相同不视为同一站。
// 历元按消息内时间（不是到达秒）分组，跨周用半周回滚判别，重复帧按内容摘要去重。

function assemble(rows) {
  const sorted = [...rows].sort((a, b) => a.offset - b.offset);
  const segments = [];
  const defects = [];
  let current = null;
  const close = () => {
    if (current) { segments.push({start: current.start, buffer: Buffer.concat(current.chunks)}); current = null; }
  };
  for (const row of sorted) {
    const data = Buffer.from(row.data, 'base64');
    if (data.length === 0) continue;
    if (!current) { current = {start: row.offset, chunks: [data], end: row.offset + data.length}; continue; }
    if (row.offset > current.end) {
      defects.push({start: current.end, end: row.offset, reason: 'byte-gap'});
      close();
      current = {start: row.offset, chunks: [data], end: row.offset + data.length};
    } else if (row.offset === current.end) {
      current.chunks.push(data);
      current.end += data.length;
    } else {
      // 重叠：同内容重收是幂等的；内容冲突保留先到字节并记录缺陷。
      const existing = Buffer.concat(current.chunks);
      const shared = Math.min(current.end - row.offset, data.length);
      const prior = existing.subarray(row.offset - current.start, row.offset - current.start + shared);
      if (!prior.equals(data.subarray(0, shared))) defects.push({start: row.offset, end: row.offset + shared, reason: 'offset-conflict'});
      const extra = row.offset + data.length - current.end;
      if (extra > 0) { current.chunks.push(data.subarray(data.length - extra)); current.end += extra; }
    }
  }
  close();
  return {segments, defects};
}

function buildConnection(connectionId, mountpoint, frames, defects) {
  const origin = offsets => ({connectionId, mountpoint, offsets});
  const counts = {stations: 0, epochs: 0, messages: 0, quality: {ok: 0, degraded: 0, unknown: 0}};
  const stationRecords = [];
  const messageRecords = [];
  const latestStation = new Map();
  const observations = [];
  for (const frame of frames) {
    const decoded = decodeMessage(frame.type, frame.payload);
    if (decoded.kind === 'station') {
      const previous = latestStation.get(decoded.station);
      const unchanged = previous && previous.antennaHeight === decoded.antennaHeight &&
        previous.coordinates.every((value, index) => value === decoded.coordinates[index]);
      if (unchanged) { previous.refreshOffsets.push(frame.offset); continue; }
      const record = {
        id: `station:${connectionId}:${decoded.station}:${previous ? previous.version + 1 : 0}`,
        kind: 'station', connectionId, mountpoint,
        stationId: decoded.station,
        version: previous ? previous.version + 1 : 0,
        coordinates: decoded.coordinates,
        definedAt: frame.offset, frameLength: frame.length, digest: frame.digest, refreshOffsets: [],
        origin: origin([frame.offset])
      };
      if (decoded.antennaHeight !== undefined) record.antennaHeight = decoded.antennaHeight;
      stationRecords.push(record);
      latestStation.set(decoded.station, record);
    } else if (decoded.kind === 'observation') {
      observations.push({frame, decoded});
    } else {
      messageRecords.push({
        id: `message:${connectionId}:${frame.offset}`, kind: 'message', connectionId, mountpoint,
        type: frame.type, name: messageTypeName(frame.type), offset: frame.offset, length: frame.length, digest: frame.digest,
        reason: decoded.kind === 'undecodable' ? `undecodable-frame:${decoded.reason}` : 'unsupported-message-type',
        origin: origin([frame.offset])
      });
    }
  }
  // 历元分组：键内是消息时间，跨周回滚按半周窗口判别，不按到达秒拼接。
  const tracks = new Map();
  const groups = new Map();
  for (const {frame, decoded} of observations) {
    const trackKey = `${decoded.station}|${decoded.constellation}`;
    const track = tracks.get(trackKey) ?? {period: 0, lastMillis: null};
    let period = track.period;
    if (track.lastMillis !== null) {
      if (decoded.epochMillis < track.lastMillis - decoded.periodMs / 2) period = track.period + 1;
      else if (decoded.epochMillis > track.lastMillis + decoded.periodMs / 2) period = track.period - 1;
    }
    tracks.set(trackKey, {period, lastMillis: decoded.epochMillis});
    const key = `${trackKey}|${period}|${decoded.dayOfWeek ?? ''}|${decoded.epochMillis}`;
    let group = groups.get(key);
    if (!group) {
      group = {constellation: decoded.constellation, stationId: decoded.station, period, epochMillis: decoded.epochMillis,
        dayOfWeek: decoded.dayOfWeek ?? null, unit: decoded.unit, messages: [], duplicates: 0};
      groups.set(key, group);
    }
    if (group.messages.some(message => message.type === frame.type && message.digest === frame.digest)) { group.duplicates++; continue; }
    const message = {type: frame.type, name: messageTypeName(frame.type), msm: decoded.msm, offset: frame.offset, length: frame.length,
      multipleMessage: decoded.multipleMessage, iods: decoded.iods, satellites: decoded.satellites, signals: decoded.signals,
      cells: decoded.cells, digest: frame.digest};
    if (frame.recovered) message.recovered = true;
    if (decoded.issues.length > 0) message.decodeIssues = decoded.issues;
    group.messages.push(message);
  }
  const epochRecords = [];
  for (const group of groups.values()) {
    group.messages.sort((a, b) => a.offset - b.offset);
    const firstOffset = group.messages[0].offset;
    const lastEnd = Math.max(...group.messages.map(message => message.offset + message.length));
    const before = stationRecords.filter(station => station.stationId === group.stationId && station.definedAt < firstOffset)
      .sort((a, b) => b.definedAt - a.definedAt)[0];
    const after = before ? null : stationRecords.filter(station => station.stationId === group.stationId)
      .sort((a, b) => a.definedAt - b.definedAt)[0];
    const station = before ?? after ?? null;
    const issues = [];
    const notes = [];
    if (!station) issues.push('no-station-definition');
    else if (after) issues.push('station-defined-after-epoch');
    const complete = group.messages.some(message => message.multipleMessage === false);
    if (!complete) issues.push('epoch-incomplete');
    const windowStart = before ? before.definedAt : 0;
    if (defects.some(defect => defect.start < lastEnd && defect.end > windowStart)) issues.push('data-loss-in-window');
    if (group.duplicates > 0) notes.push('duplicate-frames');
    // 资料不齐时绝不报告正常：无基站定义为 unknown，其余缺项为 degraded。
    const quality = !station ? 'unknown' : issues.length > 0 ? 'degraded' : 'ok';
    counts.quality[quality]++;
    epochRecords.push({
      id: `epoch:${connectionId}:${group.constellation}:${group.stationId}:${group.period}:${group.dayOfWeek !== null ? `d${group.dayOfWeek}:` : ''}${group.epochMillis}`,
      kind: 'epoch', connectionId, mountpoint,
      constellation: group.constellation, stationId: group.stationId,
      epoch: {period: group.period, millis: group.epochMillis, unit: group.unit, ...(group.dayOfWeek !== null && {dayOfWeek: group.dayOfWeek})},
      station: station ? {stationId: station.stationId, version: station.version, coordinates: station.coordinates, definedAt: station.definedAt} : null,
      complete, quality, issues, notes,
      messages: group.messages, duplicates: group.duplicates,
      origin: origin(group.messages.map(message => message.offset))
    });
  }
  const defectRecords = defects.map(defect => ({
    id: `defect:${connectionId}:${defect.start}:${defect.end}`,
    kind: 'defect', connectionId, mountpoint,
    range: [defect.start, defect.end], bytes: defect.end - defect.start, reason: defect.reason,
    ...(defect.failures !== undefined && {failures: defect.failures}),
    ...(defect.declaredLengths !== undefined && {declaredLengths: defect.declaredLengths}),
    ...(defect.declaredLength !== undefined && {declaredLength: defect.declaredLength}),
    origin: origin([defect.start])
  }));
  counts.stations = stationRecords.length;
  counts.epochs = epochRecords.length;
  counts.messages = messageRecords.length;
  return {records: [...stationRecords, ...epochRecords, ...messageRecords, ...defectRecords], counts};
}

// rows 是字节收存的原件行（connectionId、offset、base64 data，可带 mountpoint）。
// 返回 {records, summary}；records 全部带字符串 id，可直接交给 Archive.put。
export function correlate(rows, options = {}) {
  const eof = options.eof ?? true;
  const byConnection = new Map();
  for (const row of rows) {
    if (!row || typeof row.connectionId !== 'string' || typeof row.offset !== 'number' || typeof row.data !== 'string') continue;
    if (!byConnection.has(row.connectionId)) byConnection.set(row.connectionId, []);
    byConnection.get(row.connectionId).push(row);
  }
  const records = [];
  const summary = {connections: 0, frames: 0, stations: 0, epochs: 0, messages: 0, defects: 0, quality: {ok: 0, degraded: 0, unknown: 0}};
  for (const [connectionId, group] of [...byConnection.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const mountpoint = group.find(row => typeof row.mountpoint === 'string')?.mountpoint ?? options.mountpoint ?? null;
    const assembled = assemble(group);
    const frames = [];
    const defects = [...assembled.defects];
    assembled.segments.forEach((segment, index) => {
      const final = index === assembled.segments.length - 1 ? eof : true;
      const scanned = scanSegment(segment.buffer, {base: segment.start, final});
      frames.push(...scanned.frames);
      defects.push(...scanned.defects);
    });
    frames.sort((a, b) => a.offset - b.offset);
    defects.sort((a, b) => a.start - b.start || a.end - b.end);
    const built = buildConnection(connectionId, mountpoint, frames, defects);
    records.push(...built.records);
    summary.connections++;
    summary.frames += frames.length;
    summary.stations += built.counts.stations;
    summary.epochs += built.counts.epochs;
    summary.messages += built.counts.messages;
    summary.defects += defects.length;
    for (const key of ['ok', 'degraded', 'unknown']) summary.quality[key] += built.counts.quality[key];
  }
  return {records, summary};
}
