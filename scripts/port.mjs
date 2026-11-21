import { lines, pidInfo } from "../lib.mjs";

export const meta = {
  purpose:
    "What is listening: TCP and UDP listeners on a machine (all of them, or only a port), each with the process, pid, the systemd unit that owns it (user or system) and its command line. Use it for 'what is on port N', 'which port does X listen on', 'is anything serving on N'. Listeners owned by other users show no process.",
  params: { port: "a port number; omit for every listener", process: "optional: only listeners whose process name or unit contains this", machine: "default this machine", udp: "include UDP listeners, default true" },
  returns: "{machine, listeners:[{proto, address, port, process, pid, unit, scope, cmd, note}], none: bool}",
  example: 'await scripts.run("port", { port: 9989 })',
};

export default async function ({ host }, { port, process: proc, machine, udp = true }) {
  const name = host.resolve(machine);
  const info = await host.info(name);
  if (!info.reachable) return { machine: name, reachable: false, error: info.error };
  const rows = [];
  if (info.os === "darwin") {
    const r = await host.run(name, "lsof", "-nP", "-iTCP", "-sTCP:LISTEN");
    for (const l of lines(r.out).slice(1)) {
      const c = l.trim().split(/\s+/);
      const m = c[c.length - 2]?.match(/^(.*):(\d+)$/);
      if (m) rows.push({ proto: "tcp", address: m[1], port: Number(m[2]), process: c[0], pid: Number(c[1]), user: c[2] });
    }
  } else {
    for (const [proto, flag] of [["tcp", "-ltnpH"], ...(udp ? [["udp", "-lunpH"]] : [])]) {
      const r = await host.run(name, "ss", flag);
      for (const l of lines(r.out)) {
        const c = l.trim().split(/\s+/);
        const local = c.find((x, i) => i >= 3 && /:(\d+|\*)$/.test(x));
        const m = local?.match(/^(.*):(\d+)$/);
        if (!m) continue;
        const u = l.match(/users:\(\("([^"]+)",pid=(\d+)/);
        rows.push({ proto, address: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]), process: u?.[1], pid: u ? Number(u[2]) : undefined });
      }
    }
  }
  let sel = port ? rows.filter((r) => r.port === Number(port)) : rows;
  // The same listener appears for IPv4 and IPv6: merge by proto, port and pid.
  const merged = new Map();
  for (const r of sel) {
    const k = `${r.proto}:${r.port}:${r.pid ?? "?"}`;
    if (merged.has(k)) {
      if (!merged.get(k).address.split(", ").includes(r.address)) merged.get(k).address += `, ${r.address}`;
    }
    else merged.set(k, { ...r });
  }
  sel = [...merged.values()];
  if (info.os !== "darwin") {
    const pi = await pidInfo(host, name, sel.map((r) => r.pid));
    for (const r of sel) Object.assign(r, pi[r.pid] ?? {});
  }
  if (proc) sel = sel.filter((r) => `${r.process ?? ""} ${r.unit ?? ""} ${r.cmd ?? ""}`.toLowerCase().includes(String(proc).toLowerCase()));
  sel.sort((a, b) => a.port - b.port);
  for (const r of sel) r.note = r.pid ? undefined : "no process visible (owned by another user, e.g. root or docker-proxy)";
  return { machine: name, listeners: sel.slice(0, 80), more: Math.max(0, sel.length - 80), none: !sel.length, ...(port && !sel.length ? { note: `nothing listens on ${port} on ${name}` } : {}) };
}
