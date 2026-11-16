export async function collect(client) {
  return (await collectSession(client, 'LOCAL')).rows;
}

// 字节收存会话：返回原件行的同时保留领取上下文（挂载点、连接、eof），
// 供 RTCM3 关联层把帧位置回溯到具体连接与挂载点。
export async function collectSession(client, mountpoint) {
  let chosen = mountpoint;
  if (chosen === undefined) {
    const list = await client('/mountpoints');
    chosen = list?.items?.[0]?.mountpoint ?? 'LOCAL';
  }
  const connection = await client('/connect', {method:'POST',body:{mountpoint:chosen}});
  const chunks = await client(`/chunks?connection=${connection.connectionId}`);
  const rows = chunks.items.map(chunk => ({id:`${connection.connectionId}:${chunk.byteOffset}`,connectionId:connection.connectionId,
    mountpoint:chosen,offset:chunk.byteOffset,data:chunk.data,bytes:Buffer.from(chunk.data,'base64').length}));
  return {mountpoint:chosen,connectionId:connection.connectionId,eof:chunks.eof === true,rows};
}
