import { lines } from "../lib.mjs";

export const meta = {
  purpose:
    "What uses the disk: mounted filesystems with size, used and free (pseudo filesystems left out), and the biggest folders and files directly under a path (default the home folder). Stays on one filesystem. To go deeper, run it again on the biggest folder.",
  params: { path: "folder to size; default home. '/' can take minutes on a big disk", depth: "folder levels to size, default 1", top: "how many entries, default 15", machine: "default this machine", timeout: "seconds allowed for du, default 100" },
  returns: "{machine, filesystems:[{mount, size, used, avail, usePct, device}], path, biggest:[{size, bytes, path}], note?}",
  example: 'await scripts.run("disk", { path: "~/.cache" })',
};

const human = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)}G` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(0)}M` : `${Math.round(b / 1024)}K`);
const PSEUDO = /^(tmpfs|devtmpfs|dev|run|efivarfs|overlay|squashfs|proc|sysfs|cgroup2?|none)$|^\/dev\/loop/;

export default async function ({ host }, { path = "~", depth = 1, top = 15, machine, timeout = 100 }) {
  const name = host.resolve(machine);
  const info = await host.info(name);
  if (!info.reachable) return { machine: name, reachable: false, error: info.error };
  const mac = info.os === "darwin";
  // df is instant and du can take a while: start both now.
  const duP = mac ? host.runFor(name, timeout, "du", "-x", "-k", "-d", String(depth), path) : host.runFor(name, timeout, "du", "-x", "-B1", `--max-depth=${depth}`, path);
  const df = await host.run(name, "df", mac ? "-kP" : "-kP", ...(mac ? [] : []));
  const filesystems = [];
  for (const l of lines(df.out).slice(1)) {
    const c = l.trim().split(/\s+/);
    if (c.length < 6 || PSEUDO.test(c[0]) || /^\/(sys|proc|run|dev)(\/|$)/.test(c[5])) continue;
    filesystems.push({ mount: c.slice(5).join(" "), size: human(Number(c[1]) * 1024), used: human(Number(c[2]) * 1024), avail: human(Number(c[3]) * 1024), usePct: c[4], device: c[0] });
  }
  // Bind mounts and subvolumes of one device repeat its size: keep the first mount, name the others.
  const seen = new Map();
  for (const f of filesystems.slice()) {
    const k = `${f.device}|${f.size}|${f.used}`;
    if (seen.has(k)) {
      (seen.get(k).alsoMounted ??= []).push(f.mount);
      filesystems.splice(filesystems.indexOf(f), 1);
    } else seen.set(k, f);
  }
  const du = await duP;
  const mult = mac ? 1024 : 1;
  const biggest = lines(du.out)
    .map((l) => l.match(/^(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ bytes: Number(m[1]) * mult, path: m[2] }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, top + 1)
    .map((r) => ({ size: human(r.bytes), ...r }));
  const out = { machine: name, filesystems, path, biggest };
  if (du.timedOut) out.note = `du did not finish in ${timeout}s; the sizes are partial. Try a deeper path.`;
  else if (!biggest.length) out.note = (du.err || "du printed nothing").trim().slice(0, 300);
  return out;
}
