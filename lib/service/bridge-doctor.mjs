// Read-only diagnostic report for Antigravity–Codex Bridge.
// Checks live capabilities and reachability only—never compares client/server versions.
import { detectHostApp, resolveAntigravityCaller, resolveCodexCaller } from './caller-identity.mjs';
import { getLiveCodexDesktopHosts } from './codex-router.mjs';

export async function runBridgeDoctor({
  stateDir,
  env,
  deps,
  args = {},
  metadata = {},
  signal,
  refreshOwnRegistration,
  getReachableAntigravityHosts,
}) {
  await refreshOwnRegistration(metadata, signal);
  const hostApp = detectHostApp({ env, metadata });
  const checks = [];
  let callerVerified = false;

  try {
    const callerInfo =
      hostApp === 'codex'
        ? resolveCodexCaller({ metadata, env })
        : hostApp === 'antigravity'
          ? resolveAntigravityCaller({ stateDir, toolName: 'bridge_doctor', args, metadata, env, consume: true })
          : null;
    callerVerified = Boolean(callerInfo);
    checks.push({
      check: 'caller_identity',
      status: callerInfo ? 'pass' : 'warning',
      detail: callerInfo ? `${callerInfo.app}:${callerInfo.id}` : 'Caller identity not attached to this diagnostic call.',
    });
  } catch (error) {
    checks.push({ check: 'caller_identity', status: 'warning', detail: error.message });
  }

  const agyHosts = await getReachableAntigravityHosts(signal);
  const agentapi = deps.resolveAgentapiCommand(agyHosts[0], env);
  checks.push({
    check: 'antigravity_host',
    status: agyHosts.length > 0 ? 'pass' : 'fail',
    detail:
      agyHosts.length > 0
        ? `${agyHosts.length} reachable Antigravity host(s): ${agyHosts.map(h => h.lsAddress).join(', ')}`
        : 'No reachable Antigravity host registered in antigravity-host.json.',
  });
  checks.push({
    check: 'antigravity_agentapi',
    status: agentapi ? 'pass' : 'fail',
    detail: agentapi ? `Resolved: ${agentapi.command}` : 'Antigravity `agentapi` executable not found.',
  });

  const codexBin = deps.resolveCodexExecutable({ env });
  checks.push({
    check: 'codex_cli',
    status: codexBin ? 'pass' : 'fail',
    detail: codexBin ? `Resolved: ${codexBin}` : 'Codex CLI executable not found on PATH.',
  });

  let daemonReady = false;
  let conn = null;
  try {
    conn = await deps.openDaemon({ env, signal, timeoutMs: 4_000 });
    const sample = await deps.listDaemonThreads(conn, { limit: 5, signal });
    daemonReady = true;
    checks.push({
      check: 'codex_daemon',
      status: 'pass',
      detail: `Reachable (${sample.length} recent thread(s) visible).`,
    });
  } catch (error) {
    checks.push({ check: 'codex_daemon', status: 'warning', detail: error.message });
  } finally {
    conn?.close?.();
  }

  const desktopHosts = getLiveCodexDesktopHosts(stateDir, deps);
  const desktopProbes = await Promise.allSettled(
    desktopHosts.map(async host => deps.listDesktopThreads({ ...host, limit: 1, signal, timeoutMs: 2_000 })),
  );
  const desktopReady = desktopProbes.some(probe => probe.status === 'fulfilled');
  checks.push({
    check: 'codex_desktop',
    status: desktopReady ? 'pass' : desktopProbes.length ? 'warning' : 'info',
    detail: desktopReady
      ? 'Codex Desktop returned a thread listing.'
      : desktopProbes[0]?.reason?.message || 'No usable Codex Desktop local pipe registered (optional when daemon/queue is used).',
  });

  const antigravityReady = agyHosts.length > 0 && Boolean(agentapi);
  const codexReady = daemonReady || desktopReady || Boolean(codexBin);

  return {
    host_app: hostApp ?? 'unknown',
    state_dir: stateDir,
    ready: {
      antigravity_inbound: antigravityReady,
      codex_inbound: codexReady,
      two_way: callerVerified && antigravityReady && codexReady,
    },
    checks,
  };
}
