export async function run(_args: string[], vaultDir: string): Promise<void> {
  const { DaemonClient } = await import('../hooks/client.js');
  const client = new DaemonClient(vaultDir);
  const previous = client.getInfo();

  console.log('Waiting for health check...');
  const healthy = await client.restart({ checkStale: false });
  if (!healthy) {
    console.error('Daemon failed to become healthy');
    return;
  }

  const info = client.getInfo();
  if (previous?.pid) {
    console.log(`Stopped daemon ${previous.pid}`);
  } else {
    console.log('No existing daemon to stop');
  }
  if (info) {
    console.log(`Daemon healthy on port ${info.port}`);
    console.log(`Dashboard: http://localhost:${info.port}/`);
  } else {
    console.log('Daemon healthy');
  }
}
