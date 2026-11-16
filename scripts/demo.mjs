import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectSession} from '../src/reader.mjs';
import {correlate} from '../src/correlate.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const observations = new Archive(join(directory,'observations'));
const api = await createApi(archive,0,{observations});
try {
  console.log('本地来源',source.origin);
  const client = createClient(source.origin);
  const session = await collectSession(client);
  console.log('实际收件',JSON.stringify(await archive.put(session.rows,{source:source.origin,adapter:'current'})));
  const {records,summary} = correlate(session.rows,{mountpoint:session.mountpoint,eof:session.eof});
  console.log('观测关联',JSON.stringify(await observations.put(records,{source:source.origin,adapter:'rtcm3-correlator'})),JSON.stringify(summary));
  for (const record of records) console.log(' ',record.kind,JSON.stringify(record));
  const response = await fetch(`${api.origin}/records`);
  console.log('查询原始结果',await response.text());
  console.log('查询观测结果',await (await fetch(`${api.origin}/observations`)).text());
  console.log('来源交互',JSON.stringify(await client('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
