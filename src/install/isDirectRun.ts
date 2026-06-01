import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Returns true when the current process was invoked directly for the given
 * module URL (i.e., `node dist/install/foo.js`), rather than imported.
 *
 * Normalises both sides to absolute paths before comparing so that npm
 * scripts, which often pass a relative `process.argv[1]`, still match.
 */
export function isDirectRun(importMetaUrl: string): boolean {
  const moduleFile = fileURLToPath(importMetaUrl);
  const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return invokedFile === moduleFile;
}
