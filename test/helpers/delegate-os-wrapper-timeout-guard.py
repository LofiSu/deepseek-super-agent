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
    try:
        Path('/proc/self/stat').read_text()
        Path('/proc/self/cmdline').read_bytes()
        Path(f'/proc/self/task/{os.getpid()}/children').read_text()
        os.listdir('/proc')
    except OSError as error:
        raise RuntimeError(f'unsupported capability: readable Linux procfs is required: {error}') from error
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f'unsupported capability: PR_SET_CHILD_SUBREAPER failed: [{code}] {os.strerror(code)}')
    enabled = ctypes.c_int(0)
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        code = ctypes.get_errno()
        raise RuntimeError(f'unsupported capability: PR_GET_CHILD_SUBREAPER verification failed: [{code}] {os.strerror(code)}')


def preflight_rescue_capabilities():
    if not hasattr(os, 'pidfd_open'):
        raise RuntimeError('unsupported capability: Python os.pidfd_open is unavailable to the outer guard')
    if not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('unsupported capability: Python signal.pidfd_send_signal is unavailable to the outer guard')
    pidfd = None
    try:
        pidfd = os.pidfd_open(os.getpid(), 0)
        signal.pidfd_send_signal(pidfd, 0)
    except OSError as error:
        raise RuntimeError(
            f'unsupported capability: outer guard pidfd acquisition and signal-0 verification failed: '
            f'[{error.errno}] {error.strerror or str(error)}'
        ) from error
    finally:
        if pidfd is not None:
            os.close(pidfd)


def wait_for_owned_children_cleanup(timeout_s=5.0):
    """Give the live Linux subreaper time to finish cleanup after wrapper death."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        children = direct_children()
        active = False
        for pid in sorted(children):
            stat = proc_stat(pid)
            if not stat or stat['ppid'] != os.getpid():
                continue
            if stat['state'] == 'Z':
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
            else:
                active = True
        if not active and not direct_children():
            return True
        time.sleep(0.01)
    return not direct_children()


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
    if len(sys.argv) not in (4, 5, 6):
        raise RuntimeError('usage: wrapper-timeout-guard.py REPO_ROOT HOME DELAY_MS [GUARD_TIMEOUT_S [OWNERSHIP_READY_FILE]]')
    root, home, delay = map(str, sys.argv[1:4])
    guard_timeout = float(sys.argv[4]) if len(sys.argv) >= 5 else 20.0
    ownership_ready = Path(sys.argv[5]) if len(sys.argv) == 6 else None
    enable_subreaper()
    preflight_rescue_capabilities()
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
    guard_timed_out = False
    try:
        if ownership_ready is not None:
            ready_deadline = time.monotonic() + 30.0
            while not ownership_ready.exists() and child.poll() is None and time.monotonic() < ready_deadline:
                time.sleep(0.01)
            if not ownership_ready.exists():
                guard_timed_out = True
                raise subprocess.TimeoutExpired(command, 30.0)
        stdout, stderr = child.communicate(timeout=guard_timeout)
    except subprocess.TimeoutExpired:
        guard_timed_out = True
        # Popen is the exact wrapper child created above. Kill and wait for only
        # that process before rescuing descendants adopted by this subreaper.
        if child.poll() is None:
            child.kill()
        stdout, stderr = child.communicate()
    try:
        result = json.loads(stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as error:
        result = {'wrapperOutput': stdout, 'wrapperStderr': stderr, 'parseError': str(error)}
    # Let the PDEATHSIG-enabled supervisor finish its own bounded cleanup first.
    # Rescue only after that independent cleanup window has elapsed.
    supervisor_cleanup_waited = wait_for_owned_children_cleanup()
    # Reap any descendants adopted from the exact wrapper process tree. This
    # is a leak detector and cleanup fallback; any rescue makes the probe fail.
    rescues, reaped_zombies = rescue_owned_children()
    fixture_rescued = any(
        any('delegate-ipc-hold.mjs' in arg for arg in entry['argv'])
        for entry in rescues
    )
    supervisor_report = None
    report_path = os.environ.get('DS_AGENT_TEST_SUPERVISOR_REPORT_FILE')
    if report_path:
        try:
            supervisor_report = json.loads(Path(report_path).read_text())
        except (OSError, json.JSONDecodeError):
            supervisor_report = None
    report = {
        **result,
        'supervisor_report': supervisor_report,
        'supervisor_cleanup_waited': supervisor_cleanup_waited,
        'wrapper_exit_code': child.returncode,
        'wrapper_guard_timed_out': guard_timed_out,
        'wrapper_reaped': child.returncode is not None,
        'outer_guard_live_rescues': rescues,
        'outer_guard_reaped_zombies': reaped_zombies,
        'outer_guard_rescued_live_fixture': fixture_rescued,
        'outer_guard_clean': not rescues,
    }
    print(json.dumps(report, separators=(',', ':')), flush=True)
    report = result.get('report') if isinstance(result, dict) else None
    expected_success = result.get('wrapperRejected') or (
        isinstance(report, dict) and report.get('mode') == 'prepublish-kill'
        and report.get('cleanup_succeeded') is True
    )
    return 0 if child.returncode == 0 and not rescues and expected_success else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'guard_error': f'{type(error).__name__}: {str(error)[:300]}'}), flush=True)
        raise SystemExit(1)
