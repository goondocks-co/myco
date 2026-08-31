/**
 * The probe application the harness container serves until the real harness
 * entry lands: enough surface to prove the container spawns, answers on its
 * port, and can be held through a compute-shaped quiet period.
 */
const startedAt = Date.now();

Bun.serve({
  port: 8080,
  hostname: '0.0.0.0',
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/probe') {
      return Response.json({ ok: true, startedAt, uptimeMs: Date.now() - startedAt, pid: process.pid });
    }
    if (url.pathname === '/spawn') {
      // The #908 proof, kept runnable: the container can spawn a child process.
      const child = Bun.spawn(['sh', '-c', 'echo child-ok'], { stdout: 'pipe' });
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return Response.json({ code, out: out.trim() });
    }
    return new Response('not found', { status: 404 });
  },
});
console.log('probe up on 8080');
