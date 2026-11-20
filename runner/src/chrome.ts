// Claude in Chrome per thread (docs/protocol.md, "Claude in Chrome"): the
// thread's Claude CLI starts with --chrome, so its agent can drive the
// user's own signed-in Chrome. Never in Auto, which is for work on
// untrusted text.
import { ErrorCode, RpcError } from './protocol.ts';
import type { PermissionMode } from './protocol.ts';

type Shape = { chrome?: boolean; permissionMode: PermissionMode };

// Whether the CLI starts with it: asked for, outside Auto.
export function chromeAllowed(o: Shape): boolean {
  return o.chrome === true && o.permissionMode !== 'auto';
}

// Turning it on for a thread that would have it refused.
export function checkChrome(o: Omit<Shape, 'chrome'>): void {
  if (o.permissionMode === 'auto') throw new RpcError(ErrorCode.badParams, "Claude in Chrome isn't available on Auto: it's for work on untrusted text, and Chrome has the user's logins. Pick another permission mode.");
}
