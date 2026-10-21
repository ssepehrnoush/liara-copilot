// Loaded with `node -r` into every simulated app: reports RSS and CPU time to the
// simulator every 3 seconds, the way a container runtime would expose cgroup stats.
if (typeof process.send === 'function') {
  const tick = () => {
    try {
      const u = process.cpuUsage();
      process.send({ type: 'metrics', rss: process.memoryUsage.rss(), cpu: u.user + u.system });
    } catch {
      /* parent went away */
    }
  };
  setInterval(tick, 3000).unref();
  setTimeout(tick, 300).unref();
  process.on('disconnect', () => process.exit(0));
}
