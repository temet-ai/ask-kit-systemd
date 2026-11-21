# ask-kit-systemd

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about Linux services and machines. A cheap model runs `systemctl`, `journalctl`,
`ss` and `ps` outside your agent's context, here and on other machines over ssh, and answers with
the commands it ran as evidence.

Questions from its bench, which agents had answered by hand with `systemctl` and `journalctl`:

- What state is the lan-mouse service in on this machine, is it enabled, and when did it last
  stop?
- Which systemd user timers exist on this machine, and which of them have a service that last
  failed?

User and system units are both checked unless the question says which.

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) on Linux, with `systemctl`,
`journalctl`, `ss` and `ps`. Crash questions need `coredumpctl`, other machines need `ssh`.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-systemd
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-systemd        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-systemd --yes  # installs and enables it
```

Restart your agents so `ask` lists `systemd`. `ask-kit kit list` says whether it can run on this
machine, and why not. The kit is offered on Linux only.

## Settings

| Setting | Default | What it is |
|---|---|---|
| `HOSTS` | empty: this machine only | other machines, as comma-separated ssh aliases from `~/.ssh/config`, e.g. `pi,server` |

Set it in the environment or in ask-kit's config as `domains.systemd.settings.HOSTS`. Each host
must accept key login with no prompt: commands run as
`ssh -o BatchMode=yes -o ConnectTimeout=5 host -- ...`. A host that does not answer is reported as
down. On a Mac host the scripts say it has no systemd, and the investigator uses `launchctl` and
`ps` there instead.

## What it can change

When asked, it restarts, stops, starts, enables and disables units, kills processes, runs a
command as a transient unit (`systemd-run`) and deletes files. It then checks that the change took
and says what it ran.

It refuses two kinds of command, because the output goes to a model and each step has to finish:

- Commands that print secrets: `systemctl cat`, `show` of `Environment`, `env` and `printenv`,
  `ps` with environments, `/proc/<pid>/environ`, `.env`, key, token and credential files, and unit
  files read with `cat`. `host.unitFile` returns a unit file with `Environment=` hidden.
- Commands that never end: `journalctl -f`, `tail -f`, `watch`, and `top` without `-b -n`.
  `journalctl` gets `-n 200` unless the question asks for another count.

## How well it works

The bench, `bench/questions.json`, holds the kinds of question agents answer by hand, each with patterns its answer must match. They use units every systemd machine has. The bench has not been run on a model.

## What is in it

`host.mjs` runs commands on this machine or over ssh, with the refusals above. Its scripts:

| Script | For |
|---|---|
| `service` | one unit or name: state, since, restarts, pid, memory, journal, error lines |
| `failing` | failed units, failed timers, coredumps and OOM kills |
| `logs` | the journal for a unit or all of it, errors first |
| `port` | listeners, with the unit that owns each |
| `disk` | filesystems and the biggest folders |
| `top` | processes by CPU or memory |

[RECIPE.md](RECIPE.md) says what it reads and runs, and how to rebuild it.

MIT licence.
