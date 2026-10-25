import { PlatformClient } from '../packages/client/index.mjs';

async function profileDispatch() {
  let callCount = 0;
  let delay = 10;
  const mockFetch = async (url) => {
    callCount++;
    await new Promise(resolve => setTimeout(resolve, delay));
    let responseBody = {};
    if (url.includes('health')) {
      responseBody = { status: 'ok', mode: 'local', version: '1.0.0', money_movement_enabled: false, official: false };
    } else {
      responseBody = { protocol: 'freedom.preview/v1', revision: '1', protocol_sha256: '41378c3b723f739cefdf8c53a82238b1e5d69cc13cdbf63b33a80d8080c807b2', operations: [], authentication: 'member_session_csrf', external_job_execution: false, public_checkout: false };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true };
              done = true;
              return { done: false, value: new TextEncoder().encode(JSON.stringify(responseBody)) };
            },
            cancel: async () => {}
          };
        }
      }
    };
  };

  const client = new PlatformClient({ baseUrl: 'http://127.0.0.1/api/v1', fetcher: mockFetch });
  client.assertCompatible = async () => { return { protocol_sha256: '41378c3b723f739cefdf8c53a82238b1e5d69cc13cdbf63b33a80d8080c807b2' }; };

  const originalCall = client.call.bind(client);
  let totalOverhead = 0;
  client.call = async function(operationId, options) {
      const start = performance.now();
      const res = await originalCall(operationId, options);
      const end = performance.now();
      const time = end - start;
      totalOverhead += time;
      console.log(`[PROFILE] ${operationId} took ${time.toFixed(2)}ms`);
      return res;
  }

  const start = performance.now();
  await Promise.all([
    client.call('getHealth'),
    client.call('getProtocol')
  ]);
  const end = performance.now();

  console.log(`[PROFILE] Total execution time: ${(end - start).toFixed(2)}ms`);
  console.log(`[PROFILE] Total overhead time: ${totalOverhead.toFixed(2)}ms`);
}

profileDispatch().catch(console.error);
