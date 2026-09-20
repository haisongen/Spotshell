/**
 * Test-only helpers, published under the `@spotshell/core/testing` subpath so
 * the desktop workspace can drive a real `SpotShellAgent` without credentials
 * or network access. Nothing here is part of the runtime API — never import it
 * from production code.
 */
export {
  createFauxModelProvider,
  loadPiAi,
  type FauxModelProvider,
  type FauxModelProviderOptions,
  type PiAi,
  type SeenRequest,
} from './fauxModelProvider.js';
