import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The preview server, fronted by a second origin that can ship "a new release": once
 * `release()` is called it serves `/sw.js` with extra bytes, which is all a deploy is to the
 * browser. Playwright's own routing cannot stand in for this: a worker's script fetch (and its
 * periodic update check) never passes through `page.route`.
 */
export async function deployableOrigin(upstream: string): Promise<{
  readonly origin: string;
  readonly release: () => void;
  readonly close: () => Promise<void>;
}> {
  let released = false;
  const server = createServer((request, response) => {
    void (async () => {
      const target = new URL(request.url ?? '/', upstream);
      const answer = await fetch(target, { headers: { accept: request.headers.accept ?? '*/*' } });
      const headers = Object.fromEntries(
        [...answer.headers].filter(
          ([name]) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(name),
        ),
      );
      let body = Buffer.from(await answer.arrayBuffer());
      if (released && target.pathname === '/sw.js') {
        body = Buffer.concat([body, Buffer.from('\n// release 2\n')]);
      }
      response.writeHead(answer.status, headers);
      response.end(body);
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the release origin did not bind a port');
  const { port } = address satisfies AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    release: () => {
      released = true;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
