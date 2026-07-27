import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import type { AgentStatus, Heartbeat } from '../types/index.js';

export const statusCommand = new Command('status')
  .option('--instance <id>', 'Instance ID')
  .description('Show agent health and status')
  .action(async (options: { instance?: string }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    const ipc = new IPCClient(instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (daemonRunning) {
      // Get live status from daemon
      const response = await ipc.send({ type: 'status', source: 'cortextos status' });
      if (response.success) {
        const statuses = response.data as AgentStatus[];
        displayStatuses(statuses);
      }
    } else {
      // Fall back to reading heartbeat files
      console.log('Daemon is not running. Showing last known heartbeats:\n');
      const ctxRoot = join(homedir(), '.cortextos', instanceId);
      const stateDir = join(ctxRoot, 'state');

      if (!existsSync(stateDir)) {
        console.log('  No heartbeat data found.');
        console.log('  Start with: cortextos start');
        return;
      }

      const agentDirs = readdirSync(stateDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      if (agentDirs.length === 0) {
        console.log('  No agents have reported heartbeats.');
        return;
      }

      const rows: Array<{ agent: string; status: string; age: string; task: string }> = [];
      for (const agent of agentDirs) {
        const hbPath = join(stateDir, agent, 'heartbeat.json');
        try {
          const hb: Heartbeat = JSON.parse(readFileSync(hbPath, 'utf-8'));
          const ts = hb.last_heartbeat || hb.timestamp || new Date().toISOString();
          const age = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
          const ageStr = formatAge(age);
          rows.push({
            agent: hb.agent || agent,
            status: hb.status || 'unknown',
            age: ageStr,
            task: hb.current_task ? hb.current_task.substring(0, 30) : '-',
          });
        } catch {
          // Skip agents without heartbeat
        }
      }

      if (rows.length === 0) {
        console.log('  No agents have reported heartbeats.');
      } else {
        console.log('\n  Last Known Heartbeats\n');
        const header = '  Name              Status      Last Seen       Current Task';
        const separator = '  ' + '-'.repeat(header.length - 2);
        console.log(header);
        console.log(separator);
        for (const r of rows) {
          const name = r.agent.padEnd(18);
          const status = r.status.padEnd(12);
          const age = r.age.padEnd(16);
          console.log(`  ${name}${status}${age}${r.task}`);
        }
        console.log('');
      }
    }
  });

function displayStatuses(statuses: AgentStatus[]): void {
  if (statuses.length === 0) {
    console.log('No agents running.');
    console.log('Add one with: cortextos add-agent <name>');
    return;
  }

  console.log('\n  Agent Status\n');

  // Crash column makes crash-loops visible (session uptime alone resets and looks healthy).
  const header = '  Name              Status      PID       Uptime        Crashes  Model';
  const separator = '  ' + '-'.repeat(header.length - 2);
  console.log(header);
  console.log(separator);

  for (const s of statuses) {
    const name = s.name.padEnd(18);
    const crashes = s.crashCount ?? 0;
    // Surface crash loops even when current session uptime is short
    const statusLabel = crashes > 0 ? `${s.status}⚠` : s.status;
    const status = statusLabel.padEnd(12);
    const pid = (s.pid?.toString() || '-').padEnd(10);
    const uptime = s.uptime != null ? formatUptime(s.uptime).padEnd(14) : '-'.padEnd(14);
    const crashCol = String(crashes).padEnd(9);
    const model = s.model || '-';
    console.log(`  ${name}${status}${pid}${uptime}${crashCol}${model}`);
  }

  console.log('');
  if (statuses.some(s => (s.crashCount ?? 0) > 0)) {
    console.log('  ⚠ = crashCount > 0 this process life (short uptime alone can look healthy).');
    console.log('');
  }
}

/** Full unit ladder — never drop hours when days/minutes are present. */
function formatUptime(seconds: number): string {
  if (seconds < 0 || !Number.isFinite(seconds)) return '?';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`); // keep hours even when 0d is not shown but days>0
  if (days === 0 && hours === 0) {
    parts.push(`${mins}m`);
  } else if (mins > 0 || parts.length === 0) {
    parts.push(`${mins}m`);
  }
  // If we only had days and hours is 0 we still included 0h above when days>0 — good for crash diagnosis
  return parts.join(' ');
}

/** Age since last heartbeat — always keep hours when past 60m. */
function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours < 48) {
    return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h ago` : `${days}d ago`;
}
