// Helpers shared by the scripts.
export const ERR_LINE = /\b(error|fail(ed|ure)?|fatal|panic|critical|denied|timed? ?out|killed|segfault|core dumped|oom|out of memory|exception|traceback|refused|abort(ed)?|crash(ed)?)\b/i;

export const clipLine = (l, n = 240) => (l.length > n ? l.slice(0, n) + "..." : l);

/** `systemctl show` output (one or several units, blank-line separated) as an array of objects. */
export function parseShow(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split("\n").filter((l) => l.includes("=")).map((l) => l.split(/=(.*)/s).slice(0, 2))))
    .filter((o) => Object.keys(o).length);
}

export const lines = (s) => String(s ?? "").split("\n").filter(Boolean);

export const mb = (bytes) => (/^\d+$/.test(String(bytes)) ? Math.round(Number(bytes) / 1048576) : null);

/** A machine that is a Mac, unreachable, or without systemd: the answer to give instead of units. null when systemd is there. */
export async function noSystemd(host, machine) {
  const info = await host.info(machine);
  if (!info.reachable) return { machine: host.resolve(machine), reachable: false, error: info.error, note: "the machine did not answer over ssh; say so" };
  if (info.systemd) return null;
  return { machine: host.resolve(machine), os: info.os, systemd: false, note: info.os === "darwin" ? "macOS has launchctl, not systemd; use host.run(machine, 'launchctl', ...)" : "this machine does not run systemd" };
}

/** Map pids to the systemd unit that owns them (procps `ps -o unit,uunit`) and their command line. */
export async function pidInfo(host, machine, pids) {
  const out = {};
  const ids = [...new Set(pids.filter(Boolean))];
  if (!ids.length) return out;
  const r = await host.run(machine, "ps", "-o", "pid=,unit=,uunit=,etime=,args=", "-p", ids.join(","));
  for (const l of lines(r.out)) {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, unit, uunit, etime, args] = m;
    const isUser = unit.startsWith("user@") && uunit !== "-";
    out[pid] = { unit: isUser ? uunit : unit === "-" ? null : unit, scope: isUser ? "user" : unit === "-" ? null : "system", etime, cmd: host.redact(args).slice(0, 160) };
  }
  return out;
}

/** Journal lines with runs of the same message (timestamps and pids aside) folded into one line with a count. */
export function collapse(ls, n = 240) {
  const out = [];
  let prevKey = null;
  for (const l of ls) {
    const key = l.replace(/^\S+\s+/, "").replace(/\[\d+\]/g, "[]").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "").replace(/\d+/g, "#").slice(0, 120);
    if (key === prevKey && out.length) {
      const last = out[out.length - 1];
      last.count++;
      last.last = l;
    } else out.push({ text: l, count: 1, last: l });
    prevKey = key;
  }
  return out.map((o) => clipLine(o.text, n) + (o.count > 1 ? `  [x${o.count}, last at ${o.last.split(" ")[0]}]` : ""));
}

/** journalctl for a scope. Where the user journal is not stored separately ("No journal files were found", as on a Pi with volatile
 *  user journals) the system journal still holds the user manager's lines for a unit, so retry without the scope flag. */
export async function journal(host, machine, scope, args) {
  const r = await host.run(machine, "journalctl", scope, ...args);
  if (scope === "--user" && /No journal files/i.test(r.out + r.err)) {
    const r2 = await host.run(machine, "journalctl", ...args);
    r2.fallback = "no separate user journal here; lines come from the system journal (the user manager's messages for the unit, not the program's own output)";
    return r2;
  }
  return r;
}
