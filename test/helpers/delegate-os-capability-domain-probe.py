#!/usr/bin/env python3
"""Exercise supervisor baseline isolation and repeated cleanup with owned children only."""
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def main():
    home, root, node = map(str, sys.argv[1:4])
    supervisor_path = Path(root) / 'test/helpers/delegate-os-supervisor.py'
    spec = importlib.util.spec_from_file_location('delegate_os_supervisor_domain_probe', supervisor_path)
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    supervisor.install_subreaper()
    supervisor.preflight_pidfd_capabilities()
    fixture = str((Path(root) / 'test/fixtures/delegate-ipc-hold.mjs').resolve())
    owned = []

    def start_fixture(label):
        ready = Path(home) / f'{label}.ready'
        child = subprocess.Popen([node, fixture, label], cwd=root,
                                 env={**os.environ, 'DS_AGENT_TEST_FIXTURE_READY_FILE': str(ready)},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        owned.append((child, ready, fixture))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if ready.exists():
                return child
            if child.poll() is not None:
                raise RuntimeError(f'{label} fixture exited before readiness')
            time.sleep(.01)
        raise TimeoutError(f'{label} fixture did not become ready')

    def assert_live_owned(child, expected_fragment):
        stat = supervisor.proc_stat(child.pid)
        argv = supervisor.proc_cmdline(child.pid)
        if not stat or stat['ppid'] != os.getpid() or expected_fragment not in ' '.join(argv):
            raise RuntimeError(f'owned process identity changed: pid={child.pid} stat={stat} argv={argv}')
        return {'pid': child.pid, 'start_time': stat['start_time'], 'argv': argv}

    try:
        baseline = start_fixture('baseline')
        baseline_identity = assert_live_owned(baseline, fixture)
        baseline_children = supervisor.direct_children(os.getpid())
        unrelated = subprocess.Popen(['/bin/sleep', '60'], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True, close_fds=True)
        owned.append((unrelated, None, '/bin/sleep'))
        unrelated_identity = assert_live_owned(unrelated, '/bin/sleep')
        cases = []
        for index in range(3):
            candidate = start_fixture(f'cycle-{index}')
            pid, start_time, pidfd = supervisor.wait_for_adopted_delegate(
                fixture, baseline_children, timeout_s=5,
            )
            if pid != candidate.pid or pidfd is None:
                raise RuntimeError('baseline subtraction did not select the new exact fixture')
            report = {'group_signal_sent': False, 'group_absent': False,
                      'reaped_pids': [], 'reaped_delegate_pid': False}
            try:
                supervisor.cleanup_group(pid, start_time, report, timeout_s=5)
            finally:
                os.close(pidfd)
            if not report['group_absent'] or not report['reaped_delegate_pid']:
                raise RuntimeError(f'first cleanup did not reap cycle {index}: {report}')
            reentry = {'group_signal_sent': False, 'group_absent': False,
                       'reaped_pids': [], 'reaped_delegate_pid': False}
            supervisor.cleanup_group(pid, start_time, reentry, timeout_s=.1)
            baseline_after = assert_live_owned(baseline, fixture)
            unrelated_after = assert_live_owned(unrelated, '/bin/sleep')
            if baseline_after['start_time'] != baseline_identity['start_time']:
                raise RuntimeError('baseline fixture identity changed during candidate cleanup')
            if unrelated_after['start_time'] != unrelated_identity['start_time']:
                raise RuntimeError('unrelated child identity changed during candidate cleanup')
            cases.append({'candidate_pid': pid, 'cleanup': report, 'reentry': reentry,
                          'baseline_alive': True, 'unrelated_alive': True})
        return {'cases': cases, 'baseline': baseline_identity,
                'unrelated': unrelated_identity, 'baseline_alive_after_all': True,
                'unrelated_alive_after_all': True}
    finally:
        for child, _ready, expected in reversed(owned):
            if child.poll() is not None:
                continue
            stat = supervisor.proc_stat(child.pid)
            if not stat or stat['ppid'] != os.getpid():
                continue
            if expected == fixture:
                argv = supervisor.proc_cmdline(child.pid)
                if fixture not in argv:
                    continue
            elif '/bin/sleep' not in supervisor.proc_cmdline(child.pid):
                continue
            pidfd = os.pidfd_open(child.pid, 0)
            try:
                pinned = supervisor.proc_stat(child.pid)
                if pinned and pinned['start_time'] == stat['start_time'] and pinned['ppid'] == os.getpid():
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            finally:
                os.close(pidfd)
            child.wait(timeout=5)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), separators=(',', ':')), flush=True)
    except BaseException as error:
        print(json.dumps({'error': f'{type(error).__name__}: {str(error)[:300]}'}), flush=True)
        raise SystemExit(1)
