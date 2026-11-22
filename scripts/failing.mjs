import { clipLine, lines, noSystemd, parseShow } from "../lib.mjs";

export const meta = {
  purpose:
    "What is broken on a machine: failed systemd units (user and system), timers and whether their last run failed, and core dumps (coredumpctl) since a time, grouped by program; also kernel out-of-memory kills when readable. On a Mac, launchctl jobs with a non-zero last exit.",
  params: { machine: "default this machine", since: "core dumps and OOM window, default 'today'", scope: "'user' or 'system'; default both" },
  returns: "{machine, failedUnits:[{scope, unit, sub, result, exitStatus, since}], timers:[{scope, timer, triggers, lastRun, nextRun, lastResult, failed}], coredumps:{count, byProgram:{exe:count}, latest:[line]}, oom:[line], summary}",
  example: 'await scripts.run("failing", { since: "today" })',
};

export default async function ({ host }, { machine, since = "today", scope }) {
  const name = host.resolve(machine);
  const info = await host.info(name);
  if (!info.reachable) return { machine: name, reachable: false, error: info.error };
  if (!info.systemd) {
    const rows = [];
    if (info.os === "darwin") {
      const r = await host.run(name, "launchctl", "list");
      for (const l of lines(r.out).slice(1)) {
        const [pid, status, label] = l.trim().split(/\s+/);
        if (status && status !== "0" && label && !label.startsWith("com.apple.")) rows.push({ label, lastExit: status, pid });
      }
    }
    return { machine: name, os: info.os, systemd: false, launchctlNonZero: rows, note: "no systemd here" };
  }

  const failedUnits = [];
  const timers = [];
  const perScope = async (sc) => {
    const fu = [];
    const tm = [];
    const failedP = (async () => {
      const f = await host.run(name, "systemctl", sc, "list-units", "--failed", "--all", "--no-legend", "--plain");
      const names = lines(f.out).map((l) => l.trim().split(/\s+/)[0]).filter((u) => u?.includes("."));
      if (names.length) {
        const s = await host.run(name, "systemctl", sc, "show", ...names, "-p", "Id,SubState,Result,ExecMainStatus,InactiveEnterTimestamp");
        for (const p of parseShow(s.out)) fu.push({ scope: sc.slice(2), unit: p.Id, sub: p.SubState, result: p.Result, exitStatus: p.ExecMainStatus, since: p.InactiveEnterTimestamp });
      }
    })();
    const timersP = (async () => {
      const t = await host.run(name, "systemctl", sc, "list-units", "--type=timer", "--all", "--no-legend", "--plain");
      const tnames = lines(t.out).map((l) => l.trim().split(/\s+/)[0]).filter((u) => u?.endsWith(".timer"));
      if (tnames.length) {
        const s = await host.run(name, "systemctl", sc, "show", ...tnames, "-p", "Id,ActiveState,Triggers,LastTriggerUSec,NextElapseUSecRealtime");
        const rows = parseShow(s.out);
        const targets = [...new Set(rows.map((r) => r.Triggers).filter(Boolean))];
        const res = targets.length ? parseShow((await host.run(name, "systemctl", sc, "show", ...targets, "-p", "Id,Result,ExecMainStatus,ActiveState")).out) : [];
        for (const r of rows) {
          const tr = res.find((x) => x.Id === r.Triggers);
          tm.push({
            scope: sc.slice(2),
            timer: r.Id,
            state: r.ActiveState,
            triggers: r.Triggers,
            lastRun: r.LastTriggerUSec || "never",
            nextRun: r.NextElapseUSecRealtime || undefined,
            lastResult: tr ? `${tr.Result} (exit ${tr.ExecMainStatus}, ${tr.ActiveState})` : undefined,
            failed: !!tr && (tr.Result !== "success" || tr.ActiveState === "failed"),
          });
        }
      }
    })();
    await Promise.all([failedP, timersP]);
    return { fu, tm };
  };

  // Units, core dumps and OOM kills do not depend on each other.
  const [scopeRows, cd, k] = await Promise.all([
    host.scopes(name, scope).then((scs) => Promise.all(scs.map(perScope))),
    host.run(name, "coredumpctl", "list", `--since=${since}`, "--no-legend"),
    host.run(name, "journalctl", "-k", `--since=${since}`, "-g", "Out of memory|oom-kill|Killed process", "-n", "10", "-o", "short-iso"),
  ]);
  for (const { fu, tm } of scopeRows) {
    failedUnits.push(...fu);
    timers.push(...tm);
  }

  const dumps = lines(cd.out).filter((l) => /^\w{3} \d{4}-/.test(l));
  const byProgram = {};
  for (const l of dumps) {
    const exe = l.trim().split(/\s+/).find((x) => x.startsWith("/")) ?? "unknown";
    byProgram[exe] = (byProgram[exe] ?? 0) + 1;
  }
  const coredumps = { count: dumps.length, byProgram, latest: dumps.slice(-5).map((l) => clipLine(l.trim().replace(/\s+/g, " "), 160)) };
  if (cd.code === 127) coredumps.note = "coredumpctl is not installed";

  const oom = lines(k.out).filter((l) => !l.startsWith("-- ")).map((l) => clipLine(l, 200));

  const failedTimers = timers.filter((t) => t.failed);
  return {
    machine: name,
    failedUnits,
    timers,
    coredumps,
    oom,
    summary: `${failedUnits.length} failed unit(s), ${failedTimers.length} of ${timers.length} timer(s) last failed, ${dumps.length} core dump(s) since ${since}, ${oom.length} OOM line(s)`,
  };
}
