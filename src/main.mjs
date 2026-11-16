import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collectSession} from './reader.mjs';
import {correlate} from './correlate.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const directory = resolve(process.env.DATA_DIR ?? '.state');
const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const observations = new Archive(resolve(directory,'observations'));
const api = await createApi(archive,Number(process.env.PORT ?? 4020),{observations});
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const session = await collectSession(createClient(source.origin));
  console.log(JSON.stringify(await archive.put(session.rows,{source:source.origin,adapter:'current'})));
  const {records,summary} = correlate(session.rows,{mountpoint:session.mountpoint,eof:session.eof});
  console.log(JSON.stringify(await observations.put(records,{source:source.origin,adapter:'rtcm3-correlator'})));
  console.log(JSON.stringify(summary));
} catch(error) {console.error(error.message);}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
