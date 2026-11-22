import { ERR_LINE, clipLine, collapse, journal, lines } from "../lib.mjs";

export const meta = {
  purpose:
    "What the journal says: lines from one unit or the whole journal since a time, optionally filtered by a regex, with the error and warning lines listed first and the newest lines last. Checks user and system journals unless a scope is given. Use it for 'what do the logs of X say since T', 'why did X restart', 'did Y log errors today'.",
  params: {
    unit: "unit name or fragment ('my-app' or 'my-app.service'); omit for the whole journal",
    grep: "regex a line must match (journalctl --grep), e.g. 'restart|killed'",
    since: "default '-1h'; journalctl syntax ('-6h', 'today', '2026-11-18 01:00')",
    until: "optional end of the window",
    machine: "default this machine",
    scope: "'user' or 'system'; default both",
    lines: "newest lines to return per scope, default 60 (max 2000)",
    priority: "journalctl -p value, e.g. 'warning' or 'err'; default all",
  },
  returns: "{machine, results:[{scope, unit, total, errorLines:[line], tail:[line], note?}]}",
  example: 'await scripts.run("logs", { unit: "my-app", since: "-6h" })',
};

export default async function ({ host }, { unit, grep, since = "-1h", until, machine, scope, lines: n = 60, priority }) {
  const name = host.resolve(machine);
  const info = await host.info(name);
  if (!info.reachable) return { machine: name, reachable: false, error: info.error };
  if (!info.systemd) {
    if (info.os === "darwin") {
      const r = await host.run(name, "log", "show", "--last", String(since).replace(/^-/, ""), "--predicate", unit ? `process CONTAINS[c] "${unit}"` : 'eventType == "logEvent"', "--style", "compact");
      const l = lines(r.out);
      return { machine: name, os: "darwin", tail: l.slice(-n).map((x) => clipLine(x)), errorLines: l.filter((x) => ERR_LINE.test(x)).slice(-20).map((x) => clipLine(x)), note: r.err || undefined };
    }
    return { machine: name, os: info.os, systemd: false, note: "no systemd journal here" };
  }
  const perScope = async (sc) => {
    let u = unit;
    // A fragment: resolve it to real unit names so `-u my-app` does not silently match nothing.
    const units = [];
    if (unit) {
      if (/\.(service|timer|socket|target|mount|path)$/.test(unit)) units.push(unit);
      else {
        const [l, f] = await Promise.all([
          host.run(name, "systemctl", sc, "list-units", "--all", "--no-legend", "--plain", `*${unit}*`),
          host.run(name, "systemctl", sc, "list-unit-files", "--no-legend", "--plain", `*${unit}*`),
        ]);
        for (const x of [...lines(l.out), ...lines(f.out)]) {
          const nm = x.trim().split(/\s+/)[0];
          if (nm?.includes(".") && !units.includes(nm)) units.push(nm);
        }
        if (!units.length) {
          return { scope: sc.slice(2), unit, total: 0, note: `no ${sc.slice(2)} unit matches *${unit}*` };
        }
      }
    }
    const args = [sc, ...units.slice(0, 6).flatMap((x) => ["-u", x]), `--since=${since}`, ...(until ? [`--until=${until}`] : []), ...(grep ? ["-g", grep] : []), ...(priority ? ["-p", priority] : []), "-o", "short-iso", "-n", String(Math.min(n, 2000))];
    // The warning-and-above pass does not depend on the tail: run both at once.
    const [r, e] = await Promise.all([
      journal(host, name, sc, args.slice(1)),
      priority ? null : journal(host, name, sc, [...units.slice(0, 6).flatMap((x) => ["-u", x]), `--since=${since}`, ...(until ? [`--until=${until}`] : []), ...(grep ? ["-g", grep] : []), "-p", "warning", "-o", "short-iso", "-n", "30"]),
    ]);
    const l = lines(r.out).filter((x) => !x.startsWith("-- "));
    const note = !l.length ? (r.err || r.out || `no lines since ${since}`).trim().slice(0, 300) : undefined;
    // The errors in the window, not only in the tail: a second pass at priority warning and above.
    let errs = l.filter((x) => ERR_LINE.test(x));
    if (e && l.length) {
      errs = [...new Set([...lines(e.out).filter((x) => !x.startsWith("-- ")), ...errs])];
    }
    return { scope: sc.slice(2), unit: units.join(", ") || "(whole journal)", total: l.length, errorLines: collapse(errs.slice(0, 60)).slice(0, 30), tail: collapse(l), ...(note ? { note } : {}), ...(r.fallback ? { source: r.fallback } : {}) };
  };
  const results = await Promise.all((await host.scopes(name, scope)).map(perScope));
  return { machine: name, since, results };
}
