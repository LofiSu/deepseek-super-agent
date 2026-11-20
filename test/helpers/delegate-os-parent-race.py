#!/usr/bin/env python3
"""Deterministically test that a dead launching worker cannot orphan the supervisor."""

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
        if close < 0:
            return None
        fields = raw[close + 2:].split()
        return {
            'state': fields[0],
            'ppid': int(fields[1]),
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


def direct_children(pid):
    try:
        raw = Path(f'/proc/{pid}/task/{pid}/children').read_text().strip()
        return {int(value) for value in raw.split()} if raw else set()
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
        return set()


def install_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def wait_for_complete_pid(file, timeout_s=10.0):
    deadline = time.monotonic() + timeout_s
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = file.read_text().strip()
            if value.isdecimal():
                return int(value)
            last_error = ValueError('PID publication is incomplete')
        except (FileNotFoundError, OSError) as error:
            last_error = error
        time.sleep(0.01)
    raise TimeoutError(f'timed out waiting for a complete PID in {file}: {last_error}')


def waitpid_nonblocking(pid):
    try:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return None
    if waited_pid == pid:
        return os.waitstatus_to_exitcode(status)
    return None


def wait_for_pid(pid, timeout_s):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        result = waitpid_nonblocking(pid)
        if result is not None:
            return result
        time.sleep(0.01)
    return None


def signal_verified_child(pid, start_time, sig, expected_parent=None, expected_cmdline=None):
    """Signal one identity-checked process through a pidfd, never a process-name match."""
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('safe test cleanup requires Linux pidfd signaling support')
    pidfd = os.pidfd_open(pid, 0)
    try:
        stat = proc_stat(pid)
        if not stat or stat['start_time'] != start_time:
            raise RuntimeError(f'owned PID {pid} disappeared or was reused; refusing to signal it')
        if expected_parent is not None and stat['ppid'] != expected_parent:
            raise RuntimeError(f'owned PID {pid} changed parent; refusing to signal it')
        if expected_cmdline is not None and expected_cmdline not in proc_cmdline(pid):
            raise RuntimeError(f'owned PID {pid} command line changed; refusing to signal it')
        signal.pidfd_send_signal(pidfd, sig)
    finally:
        os.close(pidfd)


def reap_owned_children(timeout_s=5.0):
    """Kill and reap only descendants adopted by this dedicated test subreaper."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        children = direct_children(os.getpid())
        if not children:
            return
        for pid in children:
            stat = proc_stat(pid)
            if stat and stat['ppid'] == os.getpid():
                signal_verified_child(pid, stat['start_time'], signal.SIGKILL, expected_parent=os.getpid())
        for pid in children:
            waitpid_nonblocking(pid)
        time.sleep(0.01)
    remaining = sorted(direct_children(os.getpid()))
    if remaining:
        raise RuntimeError(f'test subreaper could not reap its owned descendants: {remaining}')


def launch_worker(home, repo_root, supervisor_script, gate, report_file, stderr_file, helper_launch_marker):
    """Short-lived parent that passes its own PID to the delayed supervisor."""
    home_path = Path(home)
    worker_pid_file = home_path / '.parent-race-worker.pid'
    supervisor_pid_file = home_path / '.parent-race-supervisor.pid'
    worker_pid_file.write_text(f'{os.getpid()}\n')
    child_env = os.environ.copy()
    child_env['DS_AGENT_TEST_PARENT_RACE_GATE'] = gate
    child_env['DS_AGENT_TEST_HELPER_LAUNCH_MARKER'] = helper_launch_marker
    with open(report_file, 'wb') as stdout, open(stderr_file, 'wb') as stderr:
        child = subprocess.Popen(
            [sys.executable, supervisor_script, 'fault', home, repo_root, 'parent-death-race-probe', str(os.getpid())],
            cwd=repo_root,
            env=child_env,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            close_fds=True,
        )
    supervisor_pid_file.write_text(f'{child.pid}\n')
    return 0


def run_harness(home, repo_root, supervisor_script):
    home_path = Path(home).resolve()
    root_path = Path(repo_root).resolve()
    supervisor_script = str(Path(supervisor_script).resolve())
    gate = str(home_path / '.parent-race-gate')
    gate_ready = Path(gate).with_suffix('.ready')
    gate_release = Path(gate).with_suffix('.release')
    report_file = home_path / '.parent-race-supervisor.stdout'
    stderr_file = home_path / '.parent-race-supervisor.stderr'
    helper_launch_marker = home_path / '.parent-race-helper-launch-attempted'
    worker_pid_file = home_path / '.parent-race-worker.pid'
    supervisor_pid_file = home_path / '.parent-race-supervisor.pid'

    worker = None
    supervisor_pid = None
    supervisor_start_time = None
    supervisor_reaped = False
    try:
        install_subreaper()
        worker = subprocess.Popen(
            [sys.executable, __file__, 'launch', str(home_path), str(root_path), supervisor_script,
             gate, str(report_file), str(stderr_file), str(helper_launch_marker)],
            cwd=str(root_path),
            env=os.environ.copy(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        gate_supervisor_pid = wait_for_complete_pid(gate_ready)
        if worker.wait(timeout=5) != 0:
            raise RuntimeError('launching worker did not exit cleanly after starting supervisor')

        supervisor_pid = gate_supervisor_pid
        if wait_for_complete_pid(supervisor_pid_file) != supervisor_pid:
            raise RuntimeError('bootstrap gate PID did not match the launched supervisor PID')
        expected_worker_pid = wait_for_complete_pid(worker_pid_file)
        supervisor_stat = proc_stat(supervisor_pid)
        if not supervisor_stat or supervisor_stat['ppid'] != os.getpid():
            raise RuntimeError('supervisor was not adopted by the test harness after worker exit')
        supervisor_start_time = supervisor_stat['start_time']
        if supervisor_script not in proc_cmdline(supervisor_pid):
            raise RuntimeError('adopted process command line did not match the supervisor script')

        # The bootstrap gate is before supervisor setup. The worker has exited
        # and the harness has adopted the supervisor before setup is released.
        gate_release.write_text('release\n')
        exit_code = wait_for_pid(supervisor_pid, 10.0)
        if exit_code is None:
            raise TimeoutError('supervisor did not fail closed after its launching worker exited')
        supervisor_reaped = True

        if not report_file.is_file():
            raise RuntimeError('supervisor did not leave its fail-closed report')
        supervisor_report = json.loads(report_file.read_text())
        if exit_code == 0:
            raise RuntimeError(f'supervisor unexpectedly succeeded after worker exit: {supervisor_report}')
        if (supervisor_report.get('failure_kind') != 'SupervisorInterrupted'
                or 'launching worker PID mismatch' not in supervisor_report.get('failure_message', '')):
            raise RuntimeError(f'supervisor failed for an unexpected reason: {supervisor_report}')

        helper_attempted = helper_launch_marker.exists()
        recovery_marker_exists = (home_path / '.delegate-os-ready').exists()
        delegate_pid_file_exists = (home_path / '.delegate-fixture.pid').exists()
        remaining_children = sorted(direct_children(os.getpid()))
        result = {
            'worker_exited_before_supervisor_setup': True,
            'worker_pid': expected_worker_pid,
            'supervisor_pid': supervisor_pid,
            'supervisor_parent_after_worker_exit': os.getpid(),
            'supervisor_exit_code': exit_code,
            'supervisor_report': supervisor_report,
            'helper_launch_attempted': helper_attempted,
            'recovery_helper_marker_exists': recovery_marker_exists,
            'delegate_pid_file_exists': delegate_pid_file_exists,
            'remaining_owned_children': remaining_children,
        }
        if helper_attempted or recovery_marker_exists or delegate_pid_file_exists or remaining_children:
            raise RuntimeError(f'parent-race test observed a helper/delegate or unreaped child: {result}')
        return result
    finally:
        # Reap the launching worker before opening its bootstrap gate on every
        # failure path, so teardown cannot accidentally launch the helper.
        if worker is not None and worker.poll() is None:
            worker.kill()
        if worker is not None:
            try:
                worker.wait(timeout=3)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
        gate_release.touch(exist_ok=True)
        if supervisor_pid is not None and not supervisor_reaped:
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                stat = proc_stat(supervisor_pid)
                if stat and stat['ppid'] == os.getpid():
                    break
                time.sleep(0.01)
            stat = proc_stat(supervisor_pid)
            if stat and supervisor_start_time is not None and stat['start_time'] == supervisor_start_time:
                signal_verified_child(
                    supervisor_pid, supervisor_start_time, signal.SIGTERM,
                    expected_parent=os.getpid(), expected_cmdline=supervisor_script,
                )
                if wait_for_pid(supervisor_pid, 3.0) is None:
                    signal_verified_child(
                        supervisor_pid, supervisor_start_time, signal.SIGKILL,
                        expected_parent=os.getpid(), expected_cmdline=supervisor_script,
                    )
                    wait_for_pid(supervisor_pid, 3.0)
            if waitpid_nonblocking(supervisor_pid) is not None:
                supervisor_reaped = True
        reap_owned_children()


def main():
    if len(sys.argv) == 9 and sys.argv[1] == 'launch':
        return launch_worker(*sys.argv[2:])
    if len(sys.argv) != 4:
        print(json.dumps({'error': 'usage: parent-race.py HOME REPO_ROOT SUPERVISOR_SCRIPT'}))
        return 2
    try:
        result = run_harness(sys.argv[1], sys.argv[2], sys.argv[3])
        print(json.dumps(result, separators=(',', ':')), flush=True)
        return 0
    except BaseException as error:
        print(json.dumps({'error': f'{type(error).__name__}: {str(error)[:400]}'}), flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
