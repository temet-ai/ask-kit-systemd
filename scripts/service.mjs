import { ERR_LINE, clipLine, collapse, journal, lines, mb, noSystemd, parseShow } from "../lib.mjs";

export const meta = {
  purpose:
    "Is a service running, failing, restarting: every systemd unit (user and system scope, loaded or only installed) whose name matches, each with active state, sub-state, since when, restart count, main PID, memory, result of the last run, the last journal lines and the error lines among them; plus processes whose command line matches. On a Mac, launchctl jobs matching.",
  params: {
    match: "part of the unit name, e.g. 'my-app' or 'my-app' (a glob-free fragment)",
    machine: "default this machine; any name in host.machines",
    scope: "'user' or 'system'; default both",
    since: "journal window, default '-3h' (journalctl --since syntax: '-1d', 'today', '2026-11-18 10:00')",
    lines: "journal lines per unit, default 15",
    max: "units to detail, default 6",
  },
  returns:
    "{machine, units:[{scope, unit, state, sub, since, restarts, mainPid, memoryMb, result, exitStatus, fragment, enabled, triggers?, nextRun?, lastRun?, journal:[line], errors:[line], journalNote?}], processes:[...], none: bool}",
  example: 'await scripts.run("service", { match: "my-app" })',
};

export default async function ({ host }, { match, machine, scope, since = "-3h", lines: nLines = 15, max = 6 }) {
  if (!match) throw new Error("service needs `match`");
  const name = host.resolve(machine);
  const info = await host.info(name);
  if (!info.reachable) return { machine: name, reachable: false, error: info.error };
  const needle = String(match).toLowerCase();

  if (!info.systemd) {
    const rows = [];
    if (info.os === "darwin") {
      const r = await host.run(name, "launchctl", "list");
      rows.push(...lines(r.out).filter((l) => l.toLowerCase().includes(needle)).map((l) => l.trim()));
    }
    const ps = await host.run(name, "ps", "-axo", "pid,etime,pcpu,pmem,comm");
    const procs = lines(ps.out).filter((l) => l.toLowerCase().includes(needle)).slice(0, 15).map((l) => clipLine(host.redact(l.trim()), 200));
    return { machine: name, os: info.os, systemd: false, launchctl: rows, processes: procs, none: !rows.length && !procs.length, note: "no systemd here" };
  }

  const found = [];
  // Process listing does not depend on the units: start it now.
  const psP = host.run(name, "ps", "-eo", "pid,etime,pcpu,pmem,args");
  const scopes = await host.scopes(name, scope);
  const listed = await Promise.all(
    scopes.map(async (sc) => {
      const [loaded, files] = await Promise.all([
        host.run(name, "systemctl", sc, "list-units", "--all", "--no-legend", "--plain", `*${match}*`),
        host.run(name, "systemctl", sc, "list-unit-files", "--no-legend", "--plain", `*${match}*`),
      ]);
      return { sc, loaded, files };
    }),
  );
  for (const { sc, loaded, files } of listed) {
    const seen = new Set();
    for (const l of lines(loaded.out)) {
      const [unit, , active, sub] = l.trim().split(/\s+/);
      if (!unit?.includes(".") || seen.has(unit)) continue;
      seen.add(unit);
      found.push({ scope: sc.slice(2), unit, active, sub, installedOnly: false });
    }
    for (const l of lines(files.out)) {
      const [unit, state] = l.trim().split(/\s+/);
      if (!unit?.includes(".") || seen.has(unit)) continue;
      seen.add(unit);
      found.push({ scope: sc.slice(2), unit, active: "inactive", sub: `not loaded (${state})`, installedOnly: true });
    }
  }
  // Running or failed units first.
  const rank = (u) => (u.active === "failed" ? 0 : u.active === "active" ? 1 : u.active === "activating" ? 1 : 2);
  found.sort((a, b) => rank(a) - rank(b));
  const units = await Promise.all(found.slice(0, max).map(async (u) => {
    const sc = `--${u.scope}`;
    const [show, jr, bad] = await Promise.all([
      host.run(
        name, "systemctl", sc, "show", u.unit, "-p",
        "ActiveState,SubState,ActiveEnterTimestamp,InactiveEnterTimestamp,NRestarts,MainPID,MemoryCurrent,Result,ExecMainStatus,FragmentPath,UnitFileState,Triggers,TriggeredBy,NextElapseUSecRealtime,LastTriggerUSec,Description",
      ),
      journal(host, name, sc, ["-u", u.unit, `--since=${since}`, "-n", String(nLines), "-o", "short-iso"]),
      journal(host, name, sc, ["-u", u.unit, `--since=${since}`, "-p", "warning", "-n", "10", "-o", "short-iso"]),
    ]);
    const p = parseShow(show.out)[0] ?? {};
    const row = {
      scope: u.scope,
      unit: u.unit,
      description: p.Description,
      state: p.ActiveState ?? u.active,
      sub: p.SubState ?? u.sub,
      since: p.ActiveState === "active" ? p.ActiveEnterTimestamp : undefined,
      stoppedAt: p.ActiveState !== "active" ? p.InactiveEnterTimestamp || undefined : undefined,
      restarts: p.NRestarts === undefined ? undefined : Number(p.NRestarts),
      mainPid: p.MainPID && p.MainPID !== "0" ? Number(p.MainPID) : undefined,
      memoryMb: mb(p.MemoryCurrent) ?? undefined,
      result: p.Result,
      exitStatus: p.ExecMainStatus,
      enabled: p.UnitFileState,
      fragment: p.FragmentPath,
      triggers: p.Triggers || undefined,
      triggeredBy: p.TriggeredBy || undefined,
      nextRun: p.NextElapseUSecRealtime || undefined,
      lastRun: p.LastTriggerUSec || undefined,
    };
    const j = lines(jr.out).filter((l) => !l.startsWith("-- "));
    row.journal = collapse(j);
    row.errors = [...new Set([...lines(bad.out).filter((l) => !l.startsWith("-- ")), ...j.filter((l) => ERR_LINE.test(l))])].slice(0, 10).map((l) => clipLine(l));
    if (jr.fallback) row.journalSource = jr.fallback;
    if (!j.length) row.journalNote = (jr.err || jr.out || "no journal lines in this window").trim().slice(0, 200) || `no journal lines since ${since}`;
    return row;
  }));

  // A thing with no unit may still run: processes whose command line matches.
  const ps = await psP;
  const processes = lines(ps.out)
    .filter((l) => l.toLowerCase().includes(needle) && !/ps -eo|ask-kit/.test(l))
    .slice(0, 10)
    .map((l) => clipLine(host.redact(l.trim()), 200));
  return { machine: name, units, moreUnits: Math.max(0, found.length - units.length), processes, none: !found.length && !processes.length };
}
