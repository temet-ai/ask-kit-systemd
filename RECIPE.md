# Recipe: the systemd kit

## What it answers

State of Linux services and machines: a unit's state, restarts and journal (user and system
scope), what the journal said since a time, timers and their last result, what listens on a port,
what crashed (coredumps, OOM), disk use, busiest processes. On this machine and on ssh hosts. It
also acts: restart, stop, start, enable, kill, clean up.

## Needs

- Node 22+ (the host's), `systemctl`, `journalctl`, `ss`, `ps`, `top`, `df`, `du`; `coredumpctl`
  for crashes; `ssh` with key login for the `HOSTS` setting.
- No network, no accounts, no keys of its own.

## Reads and runs

Runs any program on the machine you ask about, with no shell (arguments passed one by one; over ssh
each is single-quoted). Reads only what those commands print. Refuses output that would print
secrets and commands that never end (see the README). Writes nothing itself; changes happen only
when the question asks for one.

## Brief to rebuild it from an empty folder

Make a folder with an `ask-kit.toml` (id `temet.systemd`, name `systemd`, a `says` line, keywords, a
`route_hint`, `acts`, a `[[settings]]` key `HOSTS`, one `[[sources]]` of kind `module` named `host`
pointing at `host.mjs` with `api = "api.d.ts"`), plus `instructions.md`, `scripts/` and
`bench/questions.json`.

`host.mjs` exports `make({settings, push})` returning `host`:

1. Machines: this one (`os.hostname()`) plus each ssh alias in `settings.HOSTS` (or env `HOSTS`).
   `resolve(name)` maps "", "local", "here" and the hostname to this machine and throws on unknown.
2. `run(machine, program, ...args)` returns `{code, out, err, timedOut}` and never throws on a
   non-zero exit. Locally `execFile` with no shell, `SYSTEMD_PAGER=""`, `LC_ALL=C`, output cut at
   400 KB. Remotely `ssh -o BatchMode=yes -o ConnectTimeout=5 host -- <program> <args>`, each
   argument single-quoted (leave a leading `~/` outside the quotes). `runFor` adds a timeout.
3. `check(program, args)` before running: refuse `systemctl cat`, `show` without `-p` or with
   `Environment`, `show-environment`, `env`, `printenv`, `ps` with environment, secret-looking file
   paths (`.env`, key, token, credential, `/proc/*/environ`, unit files), `journalctl -f`, `tail -f`,
   `watch`, `top` without `-b -n`; add `-n 200` to `journalctl` without a count; clamp huge counts.
   The error says why, so the investigator changes its command.
4. `info(machine)` (os via `uname -s`, systemd via `/run/systemd/system`, reachable), cached;
   `scopes(machine)` gives `["--user","--system"]` or `[]`; `unitFile` is `systemctl cat` with
   `Environment=` lines hidden.

Scripts, each exporting `meta` (purpose, params, returns, example) and a default function
`({host}, params)`, each taking `machine`, and returning `{machine, ...}` or the "no systemd here" /
"did not answer" note:

- `service`: match a name against `list-units --all` and `list-unit-files` in both scopes; `show -p
  ActiveState,SubState,ActiveEnterTimestamp,InactiveEnterTimestamp,NRestarts,MainPID,MemoryCurrent,
  Result,ExecMainStatus,...`; the last N journal lines plus the warning-and-worse ones; matching
  processes from `ps`. Fall back to the system journal when `--user` says "No journal files".
- `failing`: `list-units --failed`; every timer's `show` joined to its target's `Result`;
  `coredumpctl list --since` grouped by executable; `journalctl -k -g "Out of memory|oom-kill"`.
- `logs`: resolve a fragment to unit names, `journalctl -u ... --since ... [-g] -o short-iso`, the
  error lines from a second `-p warning` pass, repeated lines folded.
- `port`: `ss -ltnpH` and `-lunpH` (or `lsof` on a Mac), merge IPv4/IPv6, map pids to units with
  `ps -o pid=,unit=,uunit=,etime=,args=`.
- `disk`: `df -kP` without pseudo filesystems and repeated bind mounts, `du -x -B1 --max-depth`.
- `top`: `top -b -n 2 -d 1` second sample for CPU, `ps --sort=-rss` for memory, units from `ps`.

`instructions.md`: how to work (scripts first; running is more than existing; both scopes; machines;
Mac; acting and verifying; refusals), and the answer format (answer first, evidence as
`machine: command` with the line). The bench holds real questions that sessions answered by hand,
with expectations checked against live state; never invented ones.

## Results

ask-kit `kit test` on 2026-11-18: deepseek-v4.1-flash 7/7 (median 28 s, $0.0069); glm-5.3-flash 7/7 (median 24 s, $0.0154).
