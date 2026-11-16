import {createServer} from 'node:http';
export async function createApi(archive,port = 0,extras = {}) {
  const routes = new Map([
    ['/health',() => ({status:'ok'})],
    ['/records',() => archive.list()]
  ]);
  if (extras.observations) routes.set('/observations',() => extras.observations.list());
  const server = createServer(async (request,response) => {
    try {
      const route = request.method === 'GET' ? routes.get(request.url) : undefined;
      if (!route) {response.writeHead(404);return response.end();}
      response.writeHead(200,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(await route(),null,2));
    } catch(error) {response.writeHead(500);response.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise(resolve => server.close(resolve))};
}
