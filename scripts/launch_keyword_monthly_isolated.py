#!/usr/bin/env python3
"""Fail-closed Linux launcher for explicit keyword-monthly copy reconstruction.

It adds a kernel seccomp filter before exec, closes inherited non-stdio FDs,
and permits only the explicitly hashed reconstruction guard. It never starts
the application or performs a provider request. Filesystem scope enforcement
inside Node remains the separately required reconstruction guard's job.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import socket
import stat
import sys
import time

SCMP_ACT_ALLOW = 0x7FFF0000
SCMP_ACT_ERRNO_EPERM = 0x00050000 | errno.EPERM
SCMP_ACT_KILL_PROCESS = 0x80000000
PR_SET_NO_NEW_PRIVS = 38
PR_GET_NO_NEW_PRIVS = 39
PR_GET_SECCOMP = 21
NETWORK_SYSCALLS = (
    "socket", "socketpair", "connect", "bind", "listen", "accept", "accept4",
    "sendto", "sendmsg", "sendmmsg", "recvfrom", "recvmsg", "recvmmsg",
    "shutdown", "getsockname", "getpeername", "setsockopt", "getsockopt",
)
# Deny asynchronous networking and cross-process FD/injection bypasses too.
BYPASS_SYSCALLS = (
    "io_uring_setup", "io_uring_enter", "io_uring_register", "pidfd_getfd",
    "ptrace", "process_vm_readv", "process_vm_writev", "bpf",
)
GUARD_NAME = "reconstruct_keyword_monthly_source_copy.cjs"
MAX_GUARD_BYTES = 1024 * 1024
MAX_PROOF_BYTES = 64 * 1024


class IsolationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise IsolationError(code)


def fingerprint(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink)


def absolute(value):
    require(isinstance(value, str) and len(value) <= 4096 and "\x00" not in value
            and os.path.isabs(value) and os.path.normpath(value) == value,
            "ISOLATION_ABSOLUTE_PATH_REQUIRED")
    return value


def directory_fd(value):
    """Open each path component without following a symlink."""
    value = absolute(value)
    require(os.path.realpath(value) == value, "ISOLATION_SYMLINK_PATH")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open("/", flags)
    try:
        for component in value.split("/")[1:]:
            if not component:
                continue
            following = os.open(component, flags, dir_fd=current)
            os.close(current)
            current = following
        require(stat.S_ISDIR(os.fstat(current).st_mode), "ISOLATION_DIRECTORY_INVALID")
        return current
    except BaseException:
        os.close(current)
        raise


def regular_digest(value, maximum, executable=False):
    value = absolute(value)
    parent = directory_fd(os.path.dirname(value))
    handle = None
    try:
        handle = os.open(os.path.basename(value), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=parent)
        before = os.fstat(handle)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and 0 < before.st_size <= maximum, "ISOLATION_FILE_BOUNDS")
        require(before.st_uid in (0, os.geteuid()) and not before.st_mode & 0o022,
                "ISOLATION_EXECUTION_FILE_NOT_TRUSTED")
        require(not executable or before.st_mode & 0o111, "ISOLATION_NODE_NOT_EXECUTABLE")
        digest = hashlib.sha256()
        total = 0
        while True:
            block = os.read(handle, min(65536, maximum + 1 - total))
            if not block:
                break
            total += len(block)
            require(total <= maximum, "ISOLATION_FILE_BOUNDS")
            digest.update(block)
        require(total == before.st_size and fingerprint(before) == fingerprint(os.fstat(handle)),
                "ISOLATION_FILE_CHANGED")
        after = os.stat(os.path.basename(value), dir_fd=parent, follow_symlinks=False)
        require(fingerprint(before) == fingerprint(after), "ISOLATION_FILE_CHANGED")
        return digest.hexdigest(), total
    finally:
        if handle is not None:
            os.close(handle)
        os.close(parent)


def proc_status():
    with open("/proc/self/status", "rb", buffering=0) as handle:
        content = handle.read(65537)
    require(len(content) <= 65536, "ISOLATION_PROC_BOUNDS")
    text = content.decode("ascii", "strict")
    result = {}
    for name in ("NoNewPrivs", "Seccomp", "Seccomp_filters"):
        values = re.findall(r"^" + name + r":\s*(\d+)\s*$", text, re.MULTILINE)
        require(len(values) == 1, "ISOLATION_PROC_FILTER_EVIDENCE_MISSING")
        result[name] = int(values[0])
    return result


def close_nonstdio():
    closed, socket_closed = 0, 0
    for number in (0, 1, 2):
        info = os.fstat(number)
        require(stat.S_ISREG(info.st_mode) or stat.S_ISCHR(info.st_mode)
                or stat.S_ISFIFO(info.st_mode), "ISOLATION_SOCKET_OR_UNSAFE_STDIO")
    names = os.listdir("/proc/self/fd")
    require(len(names) <= 65536, "ISOLATION_FD_BOUNDS")
    for name in names:
        if name.isdecimal() and int(name) > 2:
            try:
                was_socket = stat.S_ISSOCK(os.fstat(int(name)).st_mode)
                os.close(int(name))
                closed += 1
                socket_closed += int(was_socket)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise IsolationError("ISOLATION_FD_CLOSE_FAILED") from None
    # os.listdir's own transient directory FD can appear in its returned list.
    remaining = []
    for name in os.listdir("/proc/self/fd"):
        if name.isdecimal() and int(name) > 2:
            try:
                os.fstat(int(name))
                remaining.append(int(name))
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise IsolationError("ISOLATION_FD_CHECK_FAILED") from None
    require(not remaining, "ISOLATION_INHERITED_FDS_REMAIN")
    return {"closed": closed, "socketClosed": socket_closed}


def add_network_filter():
    """No fallback to a network-enabled process is permitted."""
    before = proc_status()
    try:
        library = ctypes.CDLL("libseccomp.so.2", use_errno=True)
        libc = ctypes.CDLL(None, use_errno=True)
    except OSError:
        raise IsolationError("ISOLATION_LIBSECCOMP_REQUIRED") from None
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    library.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    library.seccomp_rule_add.restype = ctypes.c_int
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_attr_set.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32]
    library.seccomp_attr_set.restype = ctypes.c_int
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_load.restype = ctypes.c_int
    library.seccomp_arch_native.restype = ctypes.c_uint32
    libc.prctl.restype = ctypes.c_int
    libc.syscall.restype = ctypes.c_long
    require(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0
            and libc.prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1,
            "ISOLATION_NO_NEW_PRIVS_FAILED")
    context = library.seccomp_init(SCMP_ACT_ALLOW)
    require(context, "ISOLATION_SECCOMP_INIT_FAILED")
    numbers = {}
    try:
        # NNP, thread synchronization, and fail-closed foreign ABI behavior.
        for attribute, value in ((3, 1), (4, 1), (2, SCMP_ACT_KILL_PROCESS)):
            require(library.seccomp_attr_set(context, attribute, value) == 0,
                    "ISOLATION_SECCOMP_ATTRIBUTES_FAILED")
        for name in NETWORK_SYSCALLS + BYPASS_SYSCALLS:
            number = library.seccomp_syscall_resolve_name(name.encode("ascii"))
            require(number >= 0, "ISOLATION_REQUIRED_SYSCALL_UNRESOLVED")
            require(library.seccomp_rule_add(context, SCMP_ACT_ERRNO_EPERM, number, 0) == 0,
                    "ISOLATION_SECCOMP_RULE_FAILED")
            numbers[name] = number
        require(library.seccomp_load(context) == 0, "ISOLATION_SECCOMP_LOAD_FAILED")
    finally:
        library.seccomp_release(context)
    after = proc_status()
    require(after["NoNewPrivs"] == 1 and after["Seccomp"] == 2
            and libc.prctl(PR_GET_SECCOMP, 0, 0, 0, 0) == 2
            and after["Seccomp_filters"] == before["Seccomp_filters"] + 1,
            "ISOLATION_KERNEL_FILTER_NOT_CONFIRMED")
    probes = {}
    # Invalid arguments could only produce EBADF/EINVAL without the new filter;
    # require our exact EPERM action for every listed networking syscall.
    for name in NETWORK_SYSCALLS:
        ctypes.set_errno(0)
        result = libc.syscall(ctypes.c_long(numbers[name]), *([ctypes.c_long(-1)] + [ctypes.c_long(0)] * 5))
        probes[name] = result == -1 and ctypes.get_errno() == errno.EPERM
    require(all(probes.values()), "ISOLATION_KERNEL_SYSCALL_PROBE_FAILED")
    socket_probes = {}
    for label, family, kind in (("tcpSocketDenied", socket.AF_INET, socket.SOCK_STREAM),
                                ("udpSocketDenied", socket.AF_INET, socket.SOCK_DGRAM),
                                ("ipv6SocketDenied", socket.AF_INET6, socket.SOCK_STREAM)):
        try:
            endpoint = socket.socket(family, kind)
        except OSError as error:
            socket_probes[label] = error.errno == errno.EPERM
        else:
            endpoint.close()
            socket_probes[label] = False
    require(all(socket_probes.values()), "ISOLATION_KERNEL_SOCKET_PROBE_FAILED")
    return {"mode": "seccomp", "noNewPrivs": True, "seccompMode": 2,
            "blockedSyscalls": list(NETWORK_SYSCALLS + BYPASS_SYSCALLS),
            "kernelProbe": {**socket_probes, "syscallsDeniedWithEperm": probes},
            "filterEvidence": {"defaultAction": "allow", "denyAction": "errno:EPERM",
                               "nativeArch": int(library.seccomp_arch_native()),
                               "foreignAbiAction": "kill_process", "threadSynchronized": True,
                               "beforeFilterCount": before["Seccomp_filters"],
                               "afterFilterCount": after["Seccomp_filters"]}}


def write_proof(root, proof, value):
    require(os.path.dirname(proof) == os.path.join(root, "control")
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json", os.path.basename(proof)),
            "ISOLATION_PROOF_OUTSIDE_CONTROL")
    directory = directory_fd(os.path.join(root, "control"))
    handle = None
    try:
        handle = os.open(os.path.basename(proof), os.O_WRONLY | os.O_CREAT | os.O_EXCL
                         | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf8")
        require(len(payload) <= MAX_PROOF_BYTES, "ISOLATION_PROOF_BOUNDS")
        offset = 0
        while offset < len(payload):
            written = os.write(handle, payload[offset:])
            require(written > 0, "ISOLATION_PROOF_WRITE_FAILED")
            offset += written
        os.fsync(handle)
        os.fsync(directory)
        info = os.fstat(handle)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == len(payload),
                "ISOLATION_PROOF_INVALID")
        require(fingerprint(info) == fingerprint(os.stat(os.path.basename(proof), dir_fd=directory,
                                                       follow_symlinks=False)), "ISOLATION_PROOF_CHANGED")
        fresh = directory_fd(os.path.join(root, "control"))
        try:
            require(os.fstat(fresh).st_dev == os.fstat(directory).st_dev
                    and os.fstat(fresh).st_ino == os.fstat(directory).st_ino,
                    "ISOLATION_PROOF_PARENT_CHANGED")
        finally:
            os.close(fresh)
    finally:
        if handle is not None:
            os.close(handle)
        os.close(directory)


def parse_args(values):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--copy-root", required=True)
    parser.add_argument("--proof", required=True)
    parser.add_argument("--code-root")
    parser.add_argument("--guard-sha256")
    parser.add_argument("--node-sha256")
    parser.add_argument("--node-max-old-space-size", type=int, default=768,
                        help="Explicit Node heap bound in MiB, 128 through 1024")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(values)
    args.command = args.command[1:] if args.command[:1] == ["--"] else args.command
    return args


def main(values=None):
    args = parse_args(sys.argv[1:] if values is None else values)
    require(sys.platform == "linux" and hasattr(os, "O_NOFOLLOW"), "ISOLATION_LINUX_REQUIRED")
    root, proof = absolute(args.copy_root), absolute(args.proof)
    require(128 <= args.node_max_old_space_size <= 1024, "ISOLATION_NODE_HEAP_BOUNDS")
    root_fd = directory_fd(root)
    os.close(root_fd)
    require(os.path.dirname(proof) == os.path.join(root, "control"), "ISOLATION_PROOF_OUTSIDE_CONTROL")
    control_fd = directory_fd(os.path.join(root, "control"))
    try:
        try:
            os.stat(os.path.basename(proof), dir_fd=control_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise IsolationError("ISOLATION_PROOF_ALREADY_EXISTS")
    finally:
        os.close(control_fd)
    guard_digest, node_digest, node_bytes = None, None, None
    if args.preflight:
        require(not args.command, "ISOLATION_PREFLIGHT_MUST_NOT_EXEC")
    else:
        require(len(args.command) >= 2 and args.code_root and args.guard_sha256 and args.node_sha256
                and re.fullmatch(r"[a-f0-9]{64}", args.guard_sha256)
                and re.fullmatch(r"[a-f0-9]{64}", args.node_sha256), "ISOLATION_GUARDED_COMMAND_REQUIRED")
        code_root = absolute(args.code_root)
        executable, guard = absolute(args.command[0]), absolute(args.command[1])
        require(os.path.basename(executable) == "node"
                and guard == os.path.join(code_root, "scripts", GUARD_NAME), "ISOLATION_GUARDED_COMMAND_REQUIRED")
        node_digest, node_bytes = regular_digest(executable, 256 * 1024 * 1024, executable=True)
        require(node_digest == args.node_sha256, "ISOLATION_NODE_SHA_MISMATCH")
        guard_digest, _ = regular_digest(guard, MAX_GUARD_BYTES)
        require(guard_digest == args.guard_sha256, "ISOLATION_GUARD_SHA_MISMATCH")
    inherited_fds = close_nonstdio()
    isolation = add_network_filter()
    close_nonstdio()
    value = {"schemaVersion": 1, **isolation, "pid": os.getpid(), "expectedRoot": root,
             "networkFdsClosed": True, "nonStandardFdsClosedBeforeExec": True,
             "inheritedNonStandardFdsClosed": inherited_fds["closed"],
             "inheritedSocketFdsClosed": inherited_fds["socketClosed"],
             "nonStandardFdsRemainingBeforeExec": 0,
             "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "preflightOnly": args.preflight, "applicationStarted": False,
             "providerCalls": 0, "unrestrictedFallbackAllowed": False,
             "guardSha256": guard_digest, "guardRequiredBeforeNormalization": True,
             "nodeSha256": node_digest, "nodeBytes": node_bytes,
             "nodeMaxOldSpaceSizeMiB": args.node_max_old_space_size,
             "execBindingMode": "trusted_path_with_pre_exec_sha_recheck",
             "environmentSanitizedForExec": not args.preflight,
             "limitations": ["Filesystem scope is enforced separately by the exact hashed Node reconstruction guard.",
                             "Trusted root/current-uid-owned Node and guard files must not be group/world writable.",
                             "Hashes and paths are rechecked before pathname exec; atomic exact-byte exec is not claimed. Trusted code/copy directories must remain unchanged.",
                             "PID remains unchanged only because execve replaces this launcher."]}
    write_proof(root, proof, value)
    close_nonstdio()
    if args.preflight:
        print("KEYWORD_MONTHLY_ISOLATION " + json.dumps({"status": "preflight_verified", "proof": proof, **value},
                                                       sort_keys=True, separators=(",", ":")), flush=True)
        return 0
    current, _ = regular_digest(args.command[1], MAX_GUARD_BYTES)
    require(current == guard_digest, "ISOLATION_GUARD_CHANGED_BEFORE_EXEC")
    current_node, _ = regular_digest(args.command[0], 256 * 1024 * 1024, executable=True)
    require(current_node == node_digest, "ISOLATION_NODE_CHANGED_BEFORE_EXEC")
    close_nonstdio()
    # No inherited NODE_OPTIONS/LD_PRELOAD/configuration values reach Node.
    command = [args.command[0], "--max-old-space-size=" + str(args.node_max_old_space_size), *args.command[1:]]
    os.execve(args.command[0], command, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "Asia/Seoul"})
    raise IsolationError("ISOLATION_EXEC_RETURNED")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except IsolationError as error:
        print(json.dumps({"status": "blocked", "code": error.code, "childStarted": False,
                          "unrestrictedFallbackAllowed": False}), file=sys.stderr)
        sys.exit(2)
    except (OSError, ValueError, UnicodeError) as error:
        print(json.dumps({"status": "blocked", "code": "ISOLATION_SYSTEM_CHECK_FAILED",
                          "errno": getattr(error, "errno", None), "childStarted": False,
                          "unrestrictedFallbackAllowed": False}), file=sys.stderr)
        sys.exit(2)
