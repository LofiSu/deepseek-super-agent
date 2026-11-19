#!/usr/bin/env python3
"""Linux subreaper for the detached delegate OS-fault tests."""

import ctypes
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36


class SupervisorInterrupted(Exception):
    pass


def interrupt(_signum, _frame):
    raise SupervisorInterrupted('supervisor interrupted')


def proc_stat(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        close = raw.rfind(')')
        if close < 0:
            return None
        fields = raw[close + 2:].split()
        return {
            'state': fields[0],
            'ppid': int(fields[1]),
            'pgrp': int(fields[2]),
            'session': int(fields[3]),
            'start_time': int(fields[19]),
        }
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, IndexError):
        return None


def proc_cmdline(pid):
    try:
        raw = Path(f'/proc/{pid}/cmdline').read_bytes()
        return [part.decode(errors='replace') for part in raw.split(b'\0') if part]
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return []


def proc_entries_for_group(pgid):
    """Inspect only the exact, previously attested detached session/process group."""
    entries = []
    try:
        pids = (name for name in os.listdir('/proc') if name.isdecimal())
    except OSError:
        return entries
    for name in pids:
        pid = int(name)
        stat = proc_stat(pid)
        if stat and stat['pgrp'] == pgid and stat['session'] == pgid:
            entries.append((pid, stat))
    return entries


def direct_children(pid):
    try:
        raw = Path(f'/proc/{pid}/task/{pid}/children').read_text().strip()
        return {int(value) for value in raw.split()} if raw else set()
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
        return set()


def install_subreaper():
    if not sys.platform.startswith('linux') or not Path('/proc/self/stat').exists():
        raise RuntimeError('delegate OS supervisor requires Linux /proc and PR_SET_CHILD_SUBREAPER')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def install_parent_death_signal():
    parent_pid = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    if os.getppid() != parent_pid:
        raise SupervisorInterrupted('test worker exited before supervisor setup completed')


def read_delegate_pid(pid_file, helper_pid, fixture):
    value = Path(pid_file).read_text().strip()
    if not value.isdecimal():
        raise RuntimeError('fixture PID file did not contain a numeric PID')
    pid = int(value)
    stat = proc_stat(pid)
    argv = proc_cmdline(pid)
    if not stat or stat['ppid'] != helper_pid:
        raise RuntimeError('fixture PID is not a live direct child of the owned recovery helper')
    if stat['pgrp'] != pid or stat['session'] != pid:
        raise RuntimeError('fixture did not lead its expected detached process group')
    if fixture not in argv:
        raise RuntimeError('fixture PID command line does not match the owned hold fixture')
    return pid, stat['start_time']


def wait_for_delegate(pid_file, helper, fixture, timeout_s=45.0):
    deadline = time.monotonic() + timeout_s
    last_error = None
    while time.monotonic() < deadline:
        if helper.poll() is not None:
            raise RuntimeError(f'recovery helper exited before fixture readiness: {helper.returncode}')
        try:
            return read_delegate_pid(pid_file, helper.pid, fixture)
        except (FileNotFoundError, RuntimeError) as error:
            last_error = error
            time.sleep(0.02)
    raise TimeoutError(f'timed out waiting for the fixture PID attestation: {last_error}')


def wait_for_marker(marker, helper, timeout_s=45.0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if marker.is_file():
            return json.loads(marker.read_text())
        if helper.poll() is not None:
            raise RuntimeError(f'recovery helper exited before readiness marker: {helper.returncode}')
        time.sleep(0.02)
    raise TimeoutError('timed out waiting for the recovery helper readiness marker')


def terminate_helper(helper):
    if helper is None:
        return None
    if helper.poll() is None:
        try:
            os.kill(helper.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        return helper.wait(timeout=10)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('failed to kill and reap the directly owned recovery helper') from error


def cleanup_group(pgid, initial_start_time, report, timeout_s=10.0):
    if pgid is None:
        report['group_absent'] = True
        report['reaped_delegate_pid'] = False
        return

    leader = proc_stat(pgid)
    members = proc_entries_for_group(pgid)
    if leader:
        if leader['start_time'] != initial_start_time:
            raise RuntimeError('process-group leader PID was reused; refusing to signal it')
        if leader['pgrp'] != pgid or leader['session'] != pgid:
            raise RuntimeError('attested process-group leader identity changed; refusing to signal it')
    elif members:
        # The group id was attested while the original leader was alive. A live
        # member keeps that exact process group allocated after leader exit.
        if not any(stat['pgrp'] == pgid and stat['session'] == pgid for _, stat in members):
            raise RuntimeError('attested process group identity is no longer present')
    else:
        report['group_absent'] = True
        report['reaped_delegate_pid'] = False
        report['reaped_pids'] = []
        return

    tracked = {pid: stat['start_time'] for pid, stat in members}
    tracked[pgid] = initial_start_time
    report['group_pids_seen'] = sorted(tracked)

    # Signal only the detached process group attested from the fixture's exact
    # PID file, command line, helper parent, session id, and start time.
    os.killpg(pgid, signal.SIGKILL)
    report['group_signal_sent'] = True

    deadline = time.monotonic() + timeout_s
    reaped = set()
    while time.monotonic() < deadline:
        for pid, stat in proc_entries_for_group(pgid):
            tracked.setdefault(pid, stat['start_time'])
        children = direct_children(os.getpid())
        for pid in sorted(children & tracked.keys()):
            stat = proc_stat(pid)
            if not stat:
                continue
            if stat['start_time'] != tracked[pid]:
                raise RuntimeError(f'owned child PID {pid} was reused; refusing to reap it')
            try:
                waited_pid, _status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError as error:
                raise RuntimeError(f'owned process {pid} was not waitable by the subreaper') from error
            if waited_pid == pid:
                reaped.add(pid)
        members = proc_entries_for_group(pgid)
        remaining = {pid for pid, _stat in members}
        remaining_children = direct_children(os.getpid()) & tracked.keys()
        if not members and not remaining_children:
            report['group_absent'] = True
            report['reaped_pids'] = sorted(reaped)
            report['reaped_delegate_pid'] = pgid in reaped
            if pgid not in reaped:
                raise RuntimeError('detached delegate exited without being reaped by the subreaper')
            return
        time.sleep(0.02)

    report['group_absent'] = not proc_entries_for_group(pgid)
    report['reaped_pids'] = sorted(reaped)
    report['reaped_delegate_pid'] = pgid in reaped
    raise RuntimeError('timed out waiting for detached process-group members to exit and be reaped')


def run(mode, home, repo_root, task):
    if mode not in ('fault', 'assertion-failure', 'timeout-failure'):
        raise ValueError(f'unsupported supervisor mode: {mode}')

    install_subreaper()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    install_parent_death_signal()

    home_path = Path(home).resolve()
    root_path = Path(repo_root).resolve()
    marker = home_path / '.delegate-os-ready'
    pid_file = home_path / '.delegate-fixture.pid'
    fixture = str((root_path / 'test/fixtures/delegate-ipc-hold.mjs').resolve())
    helper_script = str((root_path / 'test/helpers/delegate-recovery-os-child.ts').resolve())
    helper_env = os.environ.copy()
    helper_env.update({
        'DS_AGENT_HOME': str(home_path),
        'DS_AGENT_DELEGATE_TASK': task,
        'DS_AGENT_RECOVERY_CHILD_MODE': 'seed',
        'DS_AGENT_TEST_DELEGATE_PID_FILE': str(pid_file),
        'NODE_NO_WARNINGS': '1',
        'DS_AGENT_ALLOW_MOCK_FIXTURE': '1',
    })

    report = {
        'mode': mode,
        'subreaper': True,
        'helper_pid': None,
        'helper_exit_signal': None,
        'delegate_pid': None,
        'delegate_pgid': None,
        'helper_waited': False,
        'group_signal_sent': False,
        'group_absent': False,
        'reaped_pids': [],
        'reaped_delegate_pid': False,
        'failure_kind': None,
        'failure_message': None,
        'cleanup_error': None,
    }
    helper = None
    delegate_pid = None
    delegate_start_time = None
    failure = None

    try:
        helper = subprocess.Popen(
            [os.environ.get('DS_AGENT_NODE', 'node'), '--import', 'tsx', helper_script, str(home_path)],
            cwd=str(root_path),
            env=helper_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        report['helper_pid'] = helper.pid
        wait_for_marker(marker, helper)
        delegate_pid, delegate_start_time = wait_for_delegate(pid_file, helper, fixture)
        report['delegate_pid'] = delegate_pid
        report['delegate_pgid'] = delegate_pid

        if mode == 'fault':
            os.kill(helper.pid, signal.SIGKILL)
            helper_status = helper.wait(timeout=10)
            report['helper_waited'] = True
            report['helper_exit_signal'] = -helper_status if helper_status < 0 else None
            if helper_status != -signal.SIGKILL:
                raise RuntimeError('fault boundary helper was not terminated by SIGKILL')
        elif mode == 'assertion-failure':
            raise AssertionError('injected supervisor assertion failure after delegate start')
        elif mode == 'timeout-failure':
            raise TimeoutError('injected supervisor deadline after delegate start')

    except BaseException as error:
        failure = error
        report['failure_kind'] = type(error).__name__
        report['failure_message'] = str(error)[:240]

    finally:
        # Ignore another graceful interrupt while completing owned-child cleanup.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            if helper is not None:
                helper_status = terminate_helper(helper)
                report['helper_waited'] = True
                if helper_status < 0 and report['helper_exit_signal'] is None:
                    report['helper_exit_signal'] = -helper_status
            # In timeout/error cleanup, recover the attestation if it was written
            # just before the parent helper was killed.
            if delegate_pid is None and pid_file.is_file() and helper is not None:
                try:
                    value = pid_file.read_text().strip()
                    if value.isdecimal():
                        candidate = int(value)
                        stat = proc_stat(candidate)
                        argv = proc_cmdline(candidate)
                        if stat and candidate == stat['pgrp'] == stat['session'] and fixture in argv:
                            delegate_pid = candidate
                            delegate_start_time = stat['start_time']
                            report['delegate_pid'] = candidate
                            report['delegate_pgid'] = candidate
                except OSError:
                    pass
            if delegate_pid is not None:
                child_stat = proc_stat(delegate_pid)
                if child_stat and child_stat['start_time'] != delegate_start_time:
                    raise RuntimeError('detached delegate PID was reused; refusing to signal it')
                if child_stat:
                    if child_stat['ppid'] != os.getpid():
                        raise RuntimeError('detached delegate was not adopted by the test subreaper')
                    cleanup_group(delegate_pid, delegate_start_time, report)
                else:
                    # A missing leader is safe only if its whole attested group
                    # has already disappeared; a recycled PID is never signaled.
                    members = proc_entries_for_group(delegate_pid)
                    if members:
                        cleanup_group(delegate_pid, delegate_start_time, report)
                    else:
                        report['group_absent'] = True
                        report['reaped_delegate_pid'] = False
                        raise RuntimeError('attested delegate exited before the supervisor could reap it')
        except BaseException as error:
            report['cleanup_error'] = f'{type(error).__name__}: {str(error)[:240]}'

    expected_failure = (
        (mode == 'assertion-failure' and isinstance(failure, AssertionError))
        or (mode == 'timeout-failure' and isinstance(failure, TimeoutError))
    )
    report['expected_failure'] = expected_failure
    report['cleanup_succeeded'] = (
        report['cleanup_error'] is None
        and report['helper_waited']
        and report['group_absent']
        and report['reaped_delegate_pid']
    )
    if mode == 'fault' and failure is None and report['cleanup_succeeded']:
        return report, 0
    if expected_failure and report['cleanup_succeeded']:
        return report, 0
    return report, 1


def main():
    if len(sys.argv) != 5:
        print(json.dumps({'fatal': 'usage: supervisor.py MODE HOME REPO_ROOT TASK'}))
        return 2
    try:
        report, status = run(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
    except BaseException as error:
        report = {'fatal': f'{type(error).__name__}: {str(error)[:240]}'}
        status = 1
    print(json.dumps(report, separators=(',', ':')), flush=True)
    return status


if __name__ == '__main__':
    raise SystemExit(main())
