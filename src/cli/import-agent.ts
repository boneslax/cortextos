import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, cpSync } from 'fs';
import { join, basename } from 'path';
import { homedir, tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { x as tarExtract } from 'tar';
import { validateAgentName, assertSafeOrgSegment, validateInstanceId, assertContainedWithin } from '../utils/validate.js';
import { IPCClient } from '../daemon/ipc-server.js';
import { resolvePaths } from '../utils/paths.js';

interface ExportManifest {
  version: string;
  agent_name: string;
  exported_at: string;
  model?: string;
  runtime?: string;
  crons?: unknown[];
  memory_files?: string[];
  task_count?: number;
}

export const importAgentCommand = new Command('import-agent')
  .argument('<tarball>', 'Path to the .tar.gz file exported from cortextos-single')
  .option('--org <org>', 'Organization to import the agent into')
  .option('--name <name>', 'Override the agent name from the export manifest')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--no-start', 'Import files only — do not start the agent')
  .description('Import a cortextos-single agent export into full cortextOS')
  .action(async (tarball: string, options: { org?: string; name?: string; instance: string; start: boolean }) => {
    const projectRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();

    if (!existsSync(tarball)) {
      console.error(`\n  Error: file not found: ${tarball}\n`);
      process.exit(1);
    }

    // Resolve target org
    const org = options.org || autoDetectOrg(projectRoot);
    if (!org) {
      console.error('\n  Error: could not detect org. Pass --org <name>\n');
      process.exit(1);
    }
    // Validate org before it is ever joined into a filesystem path (F3 sibling:
    // an unvalidated --org would traverse out of orgs/).
    try {
      assertSafeOrgSegment(org);
      // --instance is joined into ~/.cortextos/<instance>/config/... for both
      // state-copy AND registration — validate it so it can't traverse.
      validateInstanceId(options.instance);
    } catch {
      console.error(`\n  Invalid org "${org}" or instance "${options.instance}". Allowed: letters, numbers, hyphens, underscores.\n`);
      process.exit(1);
    }

    // Unpack into a FRESH private temp dir.
    const tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-import-'));

    console.log(`\n  Unpacking ${basename(tarball)}...`);
    // node-tar extract with a strict member filter (F3 tar-slip → RCE fix):
    // reject symlink/hardlink members (the real escape vector) and any absolute
    // or `..` path. In-process — no second file read (no TOCTOU), no text-parse
    // ambiguity. node-tar additionally strips leading `/` and refuses `..` by
    // default; the explicit filter is defense-in-depth.
    try {
      await tarExtract({
        file: tarball,
        cwd: tmpDir,
        filter: (entryPath: string, entry: unknown) => {
          const t = (entry as { type?: string })?.type;
          if (t === 'SymbolicLink' || t === 'Link') return false;
          if (entryPath.startsWith('/') || entryPath.split(/[/\\]/).includes('..')) return false;
          return true;
        },
      });
    } catch (err) {
      console.error('  Failed to unpack tarball:', err instanceof Error ? err.message : String(err));
      cleanup(tmpDir);
      process.exit(1);
    }

    // Read manifest from unpacked agent/
    const agentDir = join(tmpDir, 'agent');
    if (!existsSync(agentDir)) {
      console.error('  Invalid export: no agent/ directory found in tarball.');
      cleanup(tmpDir);
      process.exit(1);
    }

    const manifestPath = join(agentDir, '.export-manifest.json');
    let manifest: ExportManifest | null = null;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      } catch { /* manifest is optional */ }
    }

    const agentName = options.name || manifest?.agent_name || 'imported-agent';

    // Validate agent name
    try {
      validateAgentName(agentName);
    } catch {
      console.error(`\n  Invalid agent name "${agentName}". Use lowercase letters, numbers, hyphens, underscores.\n`);
      cleanup(tmpDir);
      process.exit(1);
    }

    const targetAgentDir = join(projectRoot, 'orgs', org, 'agents', agentName);
    if (existsSync(targetAgentDir)) {
      console.error(`\n  Agent "${agentName}" already exists in org "${org}".`);
      console.error(`  Use --name <name> to import under a different name.\n`);
      cleanup(tmpDir);
      process.exit(1);
    }

    console.log(`  Importing as: ${agentName} → orgs/${org}/agents/${agentName}/`);

    // Create target agent dir structure
    mkdirSync(targetAgentDir, { recursive: true });

    // Copy agent contents, excluding single-agent specifics
    const SKIP_FILES = new Set(['.env', '.export-manifest.json']);
    const agentFiles = readdirSync(agentDir, { withFileTypes: true });
    for (const entry of agentFiles) {
      if (SKIP_FILES.has(entry.name)) continue;
      const src = join(agentDir, entry.name);
      const dst = join(targetAgentDir, entry.name);
      if (entry.isDirectory()) {
        cpSync(src, dst, { recursive: true });
      } else {
        const { copyFileSync } = require('fs');
        copyFileSync(src, dst);
      }
    }

    // Write a clean config.json for the full cortextOS agent
    const importedConfig = readAgentConfig(agentDir);
    const fullConfig = {
      agent_name: agentName,
      enabled: true,
      startup_delay: 0,
      max_session_seconds: 255600,
      max_crashes_per_day: 10,
      working_directory: '',
      timezone: importedConfig?.timezone || 'America/New_York',
      model: importedConfig?.model || manifest?.model || 'claude-sonnet-4-6',
      runtime: importedConfig?.runtime || manifest?.runtime || 'claude-code',
      crons: importedConfig?.crons || manifest?.crons || [],
      ecosystem: { local_version_control: { enabled: true } },
      day_mode_start: '08:00',
      day_mode_end: '00:00',
      communication_style: importedConfig?.communication_style || 'casual',
      approval_rules: {
        always_ask: ['external-comms', 'financial', 'deployment', 'data-deletion'],
        never_ask: [],
      },
    };
    writeFileSync(join(targetAgentDir, 'config.json'), JSON.stringify(fullConfig, null, 2) + '\n', 'utf-8');

    // Copy state (tasks, memory) from export if present
    const exportedStateDir = join(tmpDir, 'state');
    if (existsSync(exportedStateDir)) {
      const ctxRoot = join(homedir(), '.cortextos', options.instance);
      const paths = resolvePaths(agentName, options.instance, org);

      // Tasks
      const exportedTasks = join(exportedStateDir, 'tasks');
      if (existsSync(exportedTasks)) {
        mkdirSync(paths.taskDir, { recursive: true });
        cpSync(exportedTasks, paths.taskDir, { recursive: true });
        console.log('  Imported tasks.');
      }

      // Agent state (heartbeat, etc.). importedConfig.agent_name comes from the
      // tarball — contain the joined source against exportedStateDir so a
      // crafted `../..` name can't make cpSync read from outside the unpack dir.
      let exportedAgentState: string;
      try {
        exportedAgentState = assertContainedWithin(exportedStateDir, importedConfig?.agent_name || agentName);
      } catch {
        console.error('  Invalid agent_name in export manifest — skipping state import.');
        exportedAgentState = '';
      }
      if (exportedAgentState && existsSync(exportedAgentState)) {
        mkdirSync(paths.stateDir, { recursive: true });
        cpSync(exportedAgentState, paths.stateDir, { recursive: true });
        console.log('  Imported agent state.');
      }
    }

    // Register in enabled-agents.json
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
    let enabledAgents: Record<string, any> = {};
    try {
      if (existsSync(enabledPath)) {
        enabledAgents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
      }
    } catch { /* start fresh */ }
    enabledAgents[agentName] = { enabled: true, status: 'configured', org };
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(enabledPath, JSON.stringify(enabledAgents, null, 2) + '\n', 'utf-8');
    console.log(`  Registered in enabled-agents.json`);

    cleanup(tmpDir);

    console.log(`\n  Import complete.\n`);
    if (manifest) {
      console.log(`  From:       cortextos-single export (${manifest.exported_at})`);
      console.log(`  Agent:      ${agentName}`);
      console.log(`  Model:      ${fullConfig.model}`);
      if (manifest.crons?.length) console.log(`  Crons:      ${manifest.crons.length} restored`);
      if (manifest.memory_files?.length) console.log(`  Memory:     ${manifest.memory_files.length} files`);
    }
    console.log(`  Location:   orgs/${org}/agents/${agentName}/`);

    // Start the agent
    if (options.start) {
      const ipc = new IPCClient(options.instance);
      const daemonRunning = await ipc.isDaemonRunning();
      if (daemonRunning) {
        console.log(`\n  Starting agent...`);
        const response = await ipc.send({ type: 'start-agent', agent: agentName, source: 'import-agent' });
        if (response.success) {
          console.log(`  ${agentName}: started\n`);
        } else {
          console.log(`  Could not auto-start: ${response.error}`);
          console.log(`  Run: cortextos start ${agentName}\n`);
        }
      } else {
        console.log(`\n  Daemon not running. Start it first: cortextos start`);
        console.log(`  Then: cortextos start ${agentName}\n`);
      }
    } else {
      console.log(`\n  To start: cortextos start ${agentName}\n`);
    }
  });

function autoDetectOrg(projectRoot: string): string | null {
  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) return null;
  try {
    const orgs = readdirSync(orgsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    return orgs.length === 1 ? orgs[0] : null;
  } catch { return null; }
}

function readAgentConfig(agentDir: string): Record<string, any> | null {
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return null; }
}

function cleanup(dir: string): void {
  try { spawnSync('rm', ['-rf', dir], { stdio: 'pipe' }); } catch { /* ignore */ }
}
