import { main } from './main.js';

main().catch((err) => {
  console.error('[reach] Fatal:', err);
  process.exit(1);
});
