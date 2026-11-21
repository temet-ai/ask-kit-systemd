// The REPL's globals for the systemd kit. `help` returns this file.

declare const host: {
  here: string; // this machine's hostname
  // This machine (local: true) and every ssh alias in the HOSTS setting.
  machines: Record<string, { local: boolean; ssh?: string }>;
  // Machine name as typed ("", "local", "here" and the hostname mean this machine); throws on an unknown one.
  resolve(machine?: string): string;
  // {os: "linux" | "darwin", systemd: boolean, reachable: boolean, error?}. A Mac has launchctl, not systemd.
  // An unreachable machine is an answer: say so, with the error.
  info(machine?: string): Promise<{ os: string; systemd: boolean; reachable: boolean; error?: string }>;
  // ["--user", "--system"] on a systemd machine, [] elsewhere. Pass "user" or "system" for one.
  scopes(machine?: string, only?: string): Promise<string[]>;
  // Any command, run here or over ssh, including ones that start, stop, restart, kill or delete. No shell:
  // pass each argument separately, e.g. host.run("pi", "systemctl", "--user", "restart", "my-app.service").
  // Both scopes matter: `systemctl --user ...` for the login user's units, `systemctl ...` (no flag) for the system's.
  // Never throws on a non-zero exit. Refused (the error says why): output that prints secrets (env, printenv,
  // systemctl cat, show Environment, show-environment, ps e, /proc/PID/environ, .env/key/token/credential files, unit
  // files) and commands that never end (journalctl -f, tail -f, watch, top without -b -n). journalctl gets -n 200 when
  // you give no -n.
  run(machine: string | undefined, program: string, ...args: string[]): Promise<{ code: number; out: string; err: string; timedOut: boolean }>;
  // The same with a limit in seconds (default 120), for slow commands such as du on a big tree.
  runFor(machine: string | undefined, seconds: number, program: string, ...args: string[]): Promise<{ code: number; out: string; err: string; timedOut: boolean }>;
  // A unit file as `systemctl cat` shows it, with Environment= lines and secret-looking values hidden.
  unitFile(machine: string | undefined, scope: "user" | "system", unit: string): Promise<{ code: number; out: string; err: string }>;
  // Hides KEY=secret values and --token x style arguments in a string.
  redact(s: string): string;
};

declare const scripts: {
  list(): { name: string; purpose: string; params: Record<string, string>; returns: string; draft: boolean }[];
  show(name: string): string;
  run(name: string, params?: Record<string, unknown>): Promise<any>;
  draft(name: string, source: string): { name: string; file: string };
};

// Toolkit (also tk.*)
declare function shape(x: unknown, depth?: number): unknown;
declare function pick<T>(rows: T | T[], ...keys: string[]): any;
declare function table(rows: object[], cols?: string[], o?: { width?: number }): string;
declare function top<T>(rows: T[], key: string | ((r: T) => number), n?: number): T[];
declare function groupBy<T>(rows: T[], key: string | ((r: T) => string)): Record<string, T[]>;
declare function countBy<T>(rows: T[], key: string | ((r: T) => string)): Record<string, number>;
declare function clip(s: string | null, max?: number): string | null;
