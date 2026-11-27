// Codex multi-transport discovery & routing (daemon -> optional desktop pipe -> queue fallback).
import { failure } from '../core/outcome.mjs';
import { listCodexDesktopHosts } from '../state/host-registry.mjs';
import { DaemonUnavailableError, ThreadNotLoadedError } from '../transports/codex-daemon.mjs';

export function getLiveCodexDesktopHosts(stateDir, deps) {
  const checkSocket = deps.createLocalSocketChecker();
  return listCodexDesktopHosts(stateDir).filter(host => checkSocket(host.pipePath) !== false);
}

export async function listMergedCodexThreads({ stateDir, env, deps, limit = 30, signal }) {
  const capped = Math.max(1, Math.min(Number(limit) || 30, 50));
  const warnings = [];
  const merged = new Map();

  let conn = null;
  try {
    conn = await deps.openDaemon({ env, signal, timeoutMs: 6_000 });
    const threads = await deps.listDaemonThreads(conn, { limit: capped, signal });
    for (const t of threads) merged.set(t.thread_id, t);
  } catch (error) {
    warnings.push(`daemon: ${error.message}`);
  } finally {
    conn?.close?.();
  }

  for (const host of getLiveCodexDesktopHosts(stateDir, deps)) {
    try {
      const threads = await deps.listDesktopThreads({
        pipePath: host.pipePath,
        contextThreadId: host.contextThreadId,
        limit: capped,
        signal,
      });
      for (const t of threads) {
        if (!merged.has(t.thread_id)) merged.set(t.thread_id, t);
      }
      break;
    } catch (error) {
      warnings.push(`desktop: ${error.message}`);
    }
  }

  const threads = [...merged.values()].slice(0, capped);
  if (threads.length === 0 && warnings.length > 0) {
    throw failure(`Could not list Codex threads. ${warnings.join(' | ')}`, 'route_unavailable');
  }
  return { threads, warnings };
}

export async function dispatchMessageToCodex({
  stateDir,
  env,
  deps,
  threadId,
  envelope,
  messageId,
  transport,
  allowSteer,
  signal,
}) {
  if (transport === 'queue') {
    await deps.queueToCodexThread({ threadId, text: envelope, env, signal });
    return 'queue';
  }
  if (transport === 'desktop') {
    const hosts = getLiveCodexDesktopHosts(stateDir, deps);
    if (hosts.length === 0) {
      throw failure('No live Codex Desktop local pipe is registered.', 'route_unavailable');
    }
    await deps.sendToDesktopThread({
      pipePath: hosts[0].pipePath,
      contextThreadId: hosts[0].contextThreadId,
      threadId,
      text: envelope,
      signal,
    });
    return 'desktop';
  }

  let daemonError = null;
  let notLoaded = false;
  let conn = null;
  try {
    conn = await deps.openDaemon({ env, signal, timeoutMs: 8_000 });
    await deps.sendToDaemonThread(conn, { threadId, text: envelope, messageId, allowSteer, signal });
    return 'daemon';
  } catch (error) {
    if (error instanceof ThreadNotLoadedError) notLoaded = true;
    else if (error instanceof DaemonUnavailableError) daemonError = error;
    else throw error;
  } finally {
    conn?.close?.();
  }

  if (transport === 'daemon') {
    throw daemonError ?? failure('The selected Codex thread is not loaded in the daemon.', 'target_unavailable');
  }

  for (const host of getLiveCodexDesktopHosts(stateDir, deps)) {
    try {
      const listed = await deps.listDesktopThreads({
        pipePath: host.pipePath,
        contextThreadId: host.contextThreadId,
        limit: 50,
        signal,
      });
      if (listed.some(t => t.thread_id === threadId)) {
        await deps.sendToDesktopThread({
          pipePath: host.pipePath,
          contextThreadId: host.contextThreadId,
          threadId,
          text: envelope,
          signal,
        });
        return 'desktop';
      }
    } catch (error) {
      // The Desktop call may have been accepted before the local connection dropped.
      if (error?.deliveryUnknown || error?.reason === 'access_denied') throw error;
    }
  }

  if (notLoaded || daemonError) {
    await deps.queueToCodexThread({ threadId, text: envelope, env, signal });
    return 'queue';
  }
  throw failure('No reachable Codex transport could accept this message.', 'route_unavailable');
}
