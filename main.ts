// Entry lifecycle: bind an ephemeral port, register with the env, poll until done, exit 0.
// (Kept from the kit's starter: the harness owns this lifecycle.)
import { createApp, setExpectedToken } from './src/app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  // Local/dev mode: no env, just serve on an ephemeral port (used by the practice runner).
  const server = createApp();
  server.listen(0, () => {
    const address = server.address();
    if (address !== null && typeof address !== 'string') {
      process.stdout.write(`[entry] dev mode listening on port ${address.port}\n`);
    }
  });
} else {
  const { main } = await import('./src/lifecycle.ts');
  await main(ENV_URL, createApp, setExpectedToken);
}
