// Linux services and machines for ask-kit: run any command on this machine or on the machines named in
// HOSTS (ssh aliases). It changes things when asked (restart, stop, kill, delete). Two kinds of
// check remain, neither about changing things: output goes to a cloud model, so commands that would
// print secrets are refused; and commands that never end (follow modes, watch, top without -n) are
// refused or capped, because a cell has to finish.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const deny = (why) => {
  throw new Error(`not allowed: ${why}`);
};

const SECRET_FILE =
  /(^|\/)\.env|secret|token|credential|passw|\.pem$|id_rsa|id_ed25519|oauth|(^|[/._-])keys?($|[/._-])|\/environ$|\.ssh\/|\.aws\/|\.gnupg|\.netrc|\.npmrc|\.git-credentials|\.pgpass/i;
// Unit files carry Environment= lines: `systemctl cat` is refused for the same reason, so is reading them with cat.
const UNIT_FILE = /(^|\/)(systemd|\.config\/systemd)\/.*\.(service|conf)$|\/lib\/systemd\/.*\.service$/;
const looksLikePath = (x) => x.includes("/") || x.startsWith("~") || x.startsWith(".");
const noSecretFiles = (a, { skipPattern = false } = {}) => {
  let skipped = !skipPattern;
  for (const f of a.filter((x) => !x.startsWith("-"))) {
    if (!skipped) {
      skipped = true;
      continue;
    }
    if (SECRET_FILE.test(f)) deny(`${f} may hold secrets, and output goes to a cloud model`);
    if (UNIT_FILE.test(f)) deny(`${f} is a unit file that may hold Environment= secrets; use host.unitFile(machine, scope, unit), which redacts them`);
  }
};

// Program -> check(args). Refuses only output that leaks secrets or never ends, and adds caps.
const CHECKS = {
  systemctl(a) {
    if (a.includes("cat")) deny("systemctl cat prints Environment=; use host.unitFile(machine, scope, unit), which redacts it");
    if (a.includes("show-environment") || a.includes("import-environment")) deny("show-environment prints the environment");
    if (a.includes("edit")) deny("systemctl edit opens an editor and waits");
    if (a.includes("show") && (!a.some((x) => /^(-p|--property)/.test(x)) || a.some((x) => /Environment/i.test(x)))) deny("systemctl show needs -p, and a property list that does not include Environment (it prints secrets)");
    if (!a.includes("--no-pager")) a.unshift("--no-pager");
  },
  journalctl(a) {
    if (a.some((x) => /^(-f$|--follow|-[a-zA-Z]*f[a-zA-Z]*$)/.test(x))) deny("journalctl --follow never ends; use --since and -n");
    if (a.includes("--output=export") || a.includes("-oexport") || a.some((x, i) => x === "export" && /^-o$|^--output$/.test(a[i - 1] ?? ""))) deny("export output is binary");
    if (!a.includes("--no-pager")) a.push("--no-pager");
    const i = a.findIndex((x) => /^(-n|--lines)$/.test(x));
    const eq = a.findIndex((x) => /^(--lines=|-n\d)/.test(x));
    if (i >= 0) {
      const v = Number(a[i + 1]);
      if (!(v <= 2000)) a[i + 1] = "2000"; // "all" or a huge number
    } else if (eq < 0) a.push("-n", "200");
  },
  coredumpctl(a) {
    if (a[0] === "dump" && !a.some((x) => x === "-o" || x.startsWith("--output"))) deny("coredumpctl dump writes a binary core to stdout; give -o FILE");
    if (!a.includes("--no-pager")) a.unshift("--no-pager");
  },
  env: () => deny("env prints secrets"),
  printenv: () => deny("printenv prints secrets"),
  export: () => deny("export prints secrets"),
  watch: () => deny("watch never ends; run the command once"),
  less: () => deny("less waits for a terminal; use cat or head"),
  more: () => deny("more waits for a terminal; use cat or head"),
  top(a) {
    if (!a.some((x) => /^-[a-zA-Z]*b/.test(x))) deny("top without -b waits for a terminal; use -b -n 1");
    if (!a.some((x) => x === "-n" || /^-[a-zA-Z]*n\d*$/.test(x))) deny("top -b without -n never ends; use -b -n 2");
  },
  htop: () => deny("htop waits for a terminal; use top -b -n 2 or ps"),
  dmesg(a) {
    if (a.some((x) => /^(-w|--follow|-W|--follow-new)$/.test(x))) deny("dmesg --follow never ends");
  },
  ps(a) {
    // BSD-style letters with e (ps e, auxe, eww) print each process's environment.
    if (a.some((x) => !x.startsWith("-") && /e/.test(x) && /^[a-zA-Z]+$/.test(x) && !/^(pid|ppid|pcpu|pmem|etime|time|user|comm|command|args|rss|stat|start|lstart|euser|egroup|unit|uunit)/.test(x))) deny("ps with environment output");
    if (a.some((x) => /^-[a-zA-Z]*E/.test(x))) deny("ps -E");
  },
  ping(a) {
    if (!a.some((x) => x === "-c" || /^-c\d+$/.test(x) || x === "-w" || x === "-W")) a.unshift("-c", "3");
  },
  sudo(a) {
    if (!a.includes("-n")) a.unshift("-n"); // never wait for a password
  },
  strace: () => deny("strace never ends on a live process"),
  cat: noSecretFiles,
  head: noSecretFiles,
  tail(a) {
    if (a.some((x) => /^-[a-zA-Z]*[fF]/.test(x) || x === "--follow")) deny("tail -f never ends");
    noSecretFiles(a);
  },
  strings: noSecretFiles,
  xxd: noSecretFiles,
  od: noSecretFiles,
  zcat: noSecretFiles,
  bat: noSecretFiles,
  cp: noSecretFiles,
  grep: (a) => noSecretFiles(a, { skipPattern: true }),
  rg: (a) => noSecretFiles(a, { skipPattern: true }),
  sed: (a) => noSecretFiles(a, { skipPattern: true }),
  awk: (a) => noSecretFiles(a, { skipPattern: true }),
};

function check(program, args) {
  const a = args.map(String);
  CHECKS[program]?.(a);
  return a;
}

// One argument for the remote shell: single-quoted, with a leading ~/ left outside the quotes so it expands.
const shq = (x) => {
  const m = x.match(/^(~\/?)(.*)$/s);
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return m ? m[1] + (m[2] ? q(m[2]) : "") : q(x);
};

const OUT_CAP = 400_000;

function exec(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 << 20, encoding: "utf8", env: { ...process.env, SYSTEMD_PAGER: "", PAGER: "cat", LC_ALL: "C", TERM: "dumb" } }, (err, stdout, stderr) => {
      let out = stdout ?? "";
      if (err?.code === "ENOENT") return resolve({ code: 127, out: "", err: `${file} is not installed or not on PATH`, timedOut: false });
      if (out.length > OUT_CAP) out = out.slice(0, OUT_CAP) + `\n[output cut at ${OUT_CAP} characters]`;
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out, err: (stderr ?? "").slice(0, 2000), timedOut: !!err?.killed });
    });
  });
}

const REDACT = /((?:^|[\s"'(,;])[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|credential|auth)[A-Za-z0-9_.-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
/** Hides values that look like secrets: KEY=value pairs and --token value style arguments. */
export const redact = (s) =>
  String(s)
    .replace(REDACT, "$1[redacted]")
    .replace(/(--?[A-Za-z-]*(?:token|secret|passw(?:or)?d|api-?key|credential)[A-Za-z-]*)[= ]\S+/gi, "$1 [redacted]");

export function make({ settings = {}, push = () => {} } = {}) {
  const here = os.hostname().split(".")[0];
  const hosts = String(settings.HOSTS ?? process.env.HOSTS ?? "")
    .split(/[,\s]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .filter((h) => h !== here && h !== "local");
  const machines = { [here]: { local: true, os: process.platform === "darwin" ? "darwin" : process.platform } };
  for (const h of hosts) machines[h] = { local: false, ssh: h };
  const resolve = (name) => {
    if (name == null || name === "" || name === "local" || name === "here" || name === "localhost") return here;
    if (machines[name]) return name;
    const lower = Object.keys(machines).find((k) => k.toLowerCase() === String(name).toLowerCase());
    if (lower) return lower;
    throw new Error(`unknown machine ${name}; known: ${Object.keys(machines).join(", ")} (more are added with the HOSTS setting)`);
  };

  async function runT(machine, timeoutMs, program, ...args) {
    const name = resolve(machine);
    const m = machines[name];
    const a = check(program, args);
    const started = Date.now();
    const r = m.local
      ? await exec(program, a.map((x) => (x === "~" ? os.homedir() : x.startsWith("~/") ? os.homedir() + x.slice(1) : x)), timeoutMs)
      : await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", m.ssh, "--", shq(program), ...a.map(shq)], timeoutMs + 10_000);
    if (!m.local && r.code === 255) r.err = `ssh ${m.ssh} failed: ${r.err}`.slice(0, 600);
    push({ kind: "host", machine: name, cmd: `${program} ${a.join(" ")}`.slice(0, 200), ms: Date.now() - started, code: r.code, size: r.out.length });
    return r;
  }

  const infoCache = new Map();
  const host = {
    here,
    machines,
    resolve,

    /** Run one command on a machine (no shell). Returns {code, out, err, timedOut}; never throws on a non-zero exit. */
    run: (machine, program, ...args) => runT(machine, 120_000, program, ...args),
    /** The same with a timeout in seconds, for slow commands (du of a big tree). */
    runFor: (machine, seconds, program, ...args) => runT(machine, seconds * 1000, program, ...args),

    /** {os: "linux"|"darwin"|..., systemd: bool, reachable: bool, error?}. Cached. */
    async info(machine) {
      const name = resolve(machine);
      if (infoCache.has(name)) return infoCache.get(name);
      let r;
      if (machines[name].local) r = { os: process.platform === "darwin" ? "darwin" : process.platform, systemd: fs.existsSync("/run/systemd/system"), reachable: true };
      else {
        const u = await runT(name, 20_000, "uname", "-s");
        if (u.code !== 0) r = { os: "unknown", systemd: false, reachable: false, error: (u.err || "no answer").trim().slice(0, 300) };
        else {
          const kernel = u.out.trim().toLowerCase();
          const sd = kernel === "linux" ? await runT(name, 20_000, "test", "-d", "/run/systemd/system") : { code: 1 };
          r = { os: kernel, systemd: sd.code === 0, reachable: true };
        }
      }
      infoCache.set(name, r);
      return r;
    },

    /** ["--user", "--system"] on a systemd machine, [] elsewhere (the Mac has launchctl). */
    async scopes(machine, only) {
      const i = await host.info(machine);
      if (!i.systemd) return [];
      const all = ["--user", "--system"];
      if (!only) return all;
      const w = String(only).replace(/^--/, "");
      return all.filter((s) => s === `--${w}`);
    },

    /** A unit file as the caller would see it with `systemctl cat`, with Environment= lines and secret-looking values hidden. */
    async unitFile(machine, scope, unit) {
      const s = String(scope).startsWith("--") ? scope : `--${scope}`;
      const name = resolve(machine);
      const m = machines[name];
      const args = ["--no-pager", s, "cat", unit];
      const r = m.local ? await exec("systemctl", args, 20_000) : await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", m.ssh, "--", "systemctl", ...args.map(shq)], 30_000);
      push({ kind: "host", machine: name, cmd: `systemctl ${args.join(" ")} (redacted)`, ms: 0, code: r.code, size: r.out.length });
      const text = r.out
        .split("\n")
        .map((l) => (/^\s*(Environment|EnvironmentFile|PassEnvironment|LoadCredential|SetCredential|ImportCredential)\s*=/i.test(l) ? l.replace(/=.*/, "=[hidden]") : redact(l)))
        .join("\n");
      return { code: r.code, out: text, err: r.err };
    },

    redact,
  };
  return host;
}
