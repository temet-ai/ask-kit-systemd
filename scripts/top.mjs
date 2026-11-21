import { lines, pidInfo } from "../lib.mjs";

export const meta = {
  purpose:
    "Which processes use the CPU or memory right now: the top N by instantaneous CPU (two top samples a second apart) or by resident memory, each with user, CPU%, memory, how long it has run, its systemd unit and command line; plus load average, memory and swap use.",
  params: { by: "'cpu' (default) or 'mem'", n: "rows, default 12", machine: "default this machine" },
  returns: "{machine, by, load, memory, swap, processes:[{pid, user, cpu, mem, rssMb, etime, unit, scope, cmd}]}",
  example: 'await scripts.run("top", { by: "mem" })',
};

export default async function ({ host }, { by = "cpu", n = 12, machine }) {
  const name = host.resolve(machine);
  const info = await host.info(name);
  if (!info.reachable) return { machine: name, reachable: false, error: info.error };
  const mac = info.os === "darwin";
  const memBy = by === "mem" || by === "memory";
  let load, memory, swap;
  const procs = [];
  if (!mac) {
    // Instant CPU needs the second sample of top; ps %CPU is an average over the process's life.
    const sort = memBy ? "-rss" : "-pcpu";
    const ps = await host.run(name, "ps", "-eo", "pid=,user=,pcpu=,pmem=,rss=,etime=,args=", `--sort=${sort}`);
    let rows = lines(ps.out).map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
    if (!memBy) {
      const t = await host.runFor(name, 30, "top", "-b", "-n", "2", "-d", "1", "-w", "200");
      const frames = t.out.split(/^top - /m).filter(Boolean);
      const last = frames[frames.length - 1] ?? "";
      load = last.match(/load average: ([\d., ]+)/)?.[1]?.trim();
      memory = last.match(/Mem :\s*(.*)/)?.[1]?.trim();
      swap = last.match(/Swap:\s*(.*)/)?.[1]?.trim();
      const cpu = {};
      let inRows = false;
      for (const l of lines(last)) {
        if (/^\s*PID USER/.test(l)) {
          inRows = true;
          continue;
        }
        const c = l.trim().split(/\s+/);
        if (inRows && c.length >= 12 && /^\d+$/.test(c[0])) cpu[c[0]] = Number(c[8]);
      }
      const byPid = new Map(rows.map((r) => [r[1], r]));
      rows = Object.entries(cpu)
        .sort((x, y) => y[1] - x[1])
        .slice(0, n)
        .map(([pid, pct]) => (byPid.has(pid) ? [...byPid.get(pid).slice(0, 3), String(pct), ...byPid.get(pid).slice(4)] : null))
        .filter(Boolean);
    } else {
      const fr = await host.run(name, "free", "-m");
      memory = lines(fr.out).find((l) => l.startsWith("Mem:"))?.trim().replace(/\s+/g, " ");
      swap = lines(fr.out).find((l) => l.startsWith("Swap:"))?.trim().replace(/\s+/g, " ");
      load = (await host.run(name, "cat", "/proc/loadavg")).out.trim();
      rows = rows.slice(0, n);
    }
    const pi = await pidInfo(host, name, rows.map((r) => r[1]));
    for (const r of rows.slice(0, n)) procs.push({ pid: Number(r[1]), user: r[2], cpu: Number(r[3]), mem: Number(r[4]), rssMb: Math.round(Number(r[5]) / 1024), etime: pi[r[1]]?.etime, unit: pi[r[1]]?.unit, scope: pi[r[1]]?.scope, cmd: host.redact(r[7]).slice(0, 140) });
    return { machine: name, by: memBy ? "mem" : "cpu", load, memory, swap, processes: procs, note: memBy ? undefined : "cpu is instantaneous (top, second sample); memory is resident (rss)" };
  }
  const ps = await host.run(name, "ps", "-Aro", "pid=,user=,pcpu=,pmem=,rss=,etime=,comm=");
  let rows = lines(ps.out).map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
  rows = memBy ? rows.sort((a, b) => Number(b[5]) - Number(a[5])) : rows;
  for (const r of rows.slice(0, n)) procs.push({ pid: Number(r[1]), user: r[2], cpu: Number(r[3]), mem: Number(r[4]), rssMb: Math.round(Number(r[5]) / 1024), etime: r[6], cmd: r[7].slice(0, 140) });
  return { machine: name, by: memBy ? "mem" : "cpu", os: "darwin", processes: procs, note: "ps cpu on macOS is an average over the process's life" };
}
