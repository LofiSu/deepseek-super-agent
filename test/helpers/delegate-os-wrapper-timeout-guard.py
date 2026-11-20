#!/usr/bin/env python3
"""Outer subreaper leak guard for the real TypeScript wrapper deadline probe."""

import ctypes
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

PR_SET_CHILD_SUBREAPER = 36


def proc_stat(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        close = raw.rfind(')')
        fields = raw[close + 2:].split()
        return {'state': fields[0], 'ppid': int(fields[1]), 'start_time': int(fields[19])}
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, IndexError):
        return None


def proc_cmdline(pid):
    try:
        return [part.decode(errors='replace') for part in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if part]
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return []


def direct_children():
    try:
        raw = Path(f'/proc/{os.getpid()}/task/{os.getpid()}/children').read_text().strip()
        return {int(value) for value in raw.split()} if raw else set()
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
        return set()


def enable_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def rescue_owned_children():
    rescued = []
    reaped_zombies = []
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        children = direct_children()
        if not children:
            return rescued, reaped_zombies
        for pid in sorted(children):
            stat = proc_stat(pid)
            if not stat or stat['ppid'] != os.getpid():
                continue
            if stat['state'] == 'Z':
                try:
                    os.waitpid(pid, os.WNOHANG)
                    reaped_zombies.append(pid)
                except ChildProcessError:
                    pass
                continue
            argv = proc_cmdline(pid)
            rescued.append({'pid': pid, 'state': stat['state'], 'argv': argv})
            if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
                raise RuntimeError('outer leak guard requires pidfd signaling support')
            pidfd = os.pidfd_open(pid, 0)
            try:
                current = proc_stat(pid)
                if current and current['start_time'] == stat['start_time'] and current['ppid'] == os.getpid():
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            finally:
                os.close(pidfd)
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
        time.sleep(0.01)
    return rescued, reaped_zombies


def main():
    if len(sys.argv) != 4:
        raise RuntimeError('usage: wrapper-timeout-guard.py REPO_ROOT HOME DELAY_MS')
    root, home, delay = map(str, sys.argv[1:])
    enable_subreaper()
    env = os.environ.copy()
    env['DS_AGENT_TEST_FIXTURE_START_DELAY_MS'] = delay
    command = [
        os.environ.get('DS_AGENT_NODE', 'node'), '--import', 'tsx',
        str(Path(root) / 'test/helpers/delegate-os-wrapper-timeout-child.ts'), home,
    ]
    child = subprocess.Popen(
        command, cwd=root, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, close_fds=True,
    )
    stdout, stderr = child.communicate(timeout=20)
    try:
        result = json.loads(stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as error:
        result = {'wrapperOutput': stdout, 'wrapperStderr': stderr, 'parseError': str(error)}
    # Reap any descendants adopted from the exact wrapper process tree. This
    # is a leak detector and cleanup fallback; any rescue makes the probe fail.
    rescues, reaped_zombies = rescue_owned_children()
    fixture_rescued = any(
        any('delegate-ipc-hold.mjs' in arg for arg in entry['argv'])
        for entry in rescues
    )
    report = {
        **result,
        'wrapper_exit_code': child.returncode,
        'outer_guard_live_rescues': rescues,
        'outer_guard_reaped_zombies': reaped_zombies,
        'outer_guard_rescued_live_fixture': fixture_rescued,
        'outer_guard_clean': not rescues,
    }
    print(json.dumps(report, separators=(',', ':')), flush=True)
    return 0 if child.returncode == 0 and not rescues and result.get('wrapperRejected') else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'guard_error': f'{type(error).__name__}: {str(error)[:300]}'}), flush=True)
        raise SystemExit(1)
