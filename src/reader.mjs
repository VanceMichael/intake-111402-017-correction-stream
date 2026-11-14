export async function collect(client) {
  const connection = await client('/connect', {method:'POST',body:{mountpoint:'LOCAL'}});
  const chunks = await client(`/chunks?connection=${connection.connectionId}`);
  return chunks.items.map(chunk => ({id:`${connection.connectionId}:${chunk.byteOffset}`,connectionId:connection.connectionId,
    offset:chunk.byteOffset,data:chunk.data,bytes:Buffer.from(chunk.data,'base64').length}));
}
