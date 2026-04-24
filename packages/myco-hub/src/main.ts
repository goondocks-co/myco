#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig } from './paths.js';
import { openBrowser } from './open-browser.js';
import { installService, serviceStatus, startService, stopService, uninstallService, writePidFile, ensureDefaultConfig } from './service.js';
import { serve } from './server.js';

declare const __MYCO_HUB_VERSION__: string;

const USAGE = `Usage: myco-hub <command>

Commands:
  install       Install and start the per-user hub service
  uninstall     Stop and remove the per-user hub service
  serve         Run the hub server in the foreground
  start         Start the installed service
  stop          Stop the installed service
  restart       Restart the installed service
  status        Print service status
  logs          Print the hub log
  open          Open the hub in your browser
  version       Show package version
`;

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  switch (command) {
    case 'install':
      ensureDefaultConfig();
      installService();
      printStatus();
      return;
    case 'uninstall':
      uninstallService();
      console.log('Myco Hub service removed');
      return;
    case 'serve':
      writePidFile();
      await serve();
      return;
    case 'start':
      startService();
      printStatus();
      return;
    case 'stop':
      stopService();
      console.log('Myco Hub service stopped');
      return;
    case 'restart':
      stopService();
      startService();
      printStatus();
      return;
    case 'status':
      printStatus();
      return;
    case 'logs':
      printLogs();
      return;
    case 'open': {
      const config = loadConfig();
      const url = `http://${config.host}:${config.port}/`;
      openBrowser(url);
      console.log(`Opened ${url}`);
      return;
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(typeof __MYCO_HUB_VERSION__ === 'string' ? __MYCO_HUB_VERSION__ : 'dev');
      return;
    default:
      console.error(`Unknown myco-hub command: ${command}`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

function printStatus(): void {
  const status = serviceStatus();
  console.log(`Myco Hub: ${status.running ? 'running' : 'stopped'}`);
  if (status.pid) console.log(`PID: ${status.pid}`);
  console.log(`URL: ${status.url}`);
  console.log(`Config: ${status.configPath}`);
  console.log(`Log: ${status.logPath}`);
}

function printLogs(): void {
  const status = serviceStatus();
  try {
    process.stdout.write(fs.readFileSync(status.logPath, 'utf-8'));
  } catch {
    console.log(`No log found at ${status.logPath}`);
  }
}

await main();
