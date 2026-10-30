#!/usr/bin/env python3
"""Synthetic local Linux tests. No application, provider or production data."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
LAUNCHER = HERE / "launch_keyword_monthly_isolated.py"
NODE = None
NODE_SHA = None


@unittest.skipUnless(sys.platform == "linux", "Linux seccomp tests require Linux")
class IsolatedLauncherTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="keyword-monthly-isolation-fixture-"))
        (self.root / "control").mkdir()
        self.code = self.root / "code"
        (self.code / "scripts").mkdir(parents=True)
        self.guard = self.code / "scripts" / "reconstruct_keyword_monthly_source_copy.cjs"
        self.guard.write_text('"use strict";const fs=require("node:fs"),assert=require("node:assert/strict");'
            'const p=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));'
            'assert.equal(p.pid,process.pid);assert.equal(p.mode,"seccomp");'
            'assert.equal(p.noNewPrivs,true);assert.equal(p.seccompMode,2);'
            'const status=fs.readFileSync("/proc/self/status","utf8");'
            'assert.match(status,/^NoNewPrivs:\\s+1$/m);assert.match(status,/^Seccomp:\\s+2$/m);'
            'const net=require("node:net"),dgram=require("node:dgram");'
            'Promise.all([new Promise(resolve=>{const s=net.createConnection({host:"127.0.0.1",port:9});'
            's.once("error",e=>{s.destroy();assert.equal(e.code,"EPERM");resolve(true);});'
            's.once("connect",()=>{throw Error("NETWORK_WAS_ALLOWED")});}),'
            'new Promise(resolve=>{const s=dgram.createSocket("udp4");s.once("error",e=>{'
            'try{s.close()}catch{}assert.equal(e.code,"EPERM");resolve(true);});'
            's.bind(0,"127.0.0.1",()=>{throw Error("UDP_WAS_ALLOWED")});})]).then(()=>{'
            'fs.writeFileSync(process.argv[3],JSON.stringify({pid:process.pid,proofPid:p.pid,'
            'tcpDenied:true,udpDenied:true,execInheritedKernelFilter:true}),{flag:"wx"});'
            'console.log("SYNTHETIC_NODE_ISOLATION_OK");});', encoding="utf8")
        self.sha = hashlib.sha256(self.guard.read_bytes()).hexdigest()

    def tearDown(self):
        # Only remove the freshly created, explicitly checked fixture root.
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()))
        self.assertTrue(self.root.name.startswith("keyword-monthly-isolation-fixture-"))
        shutil.rmtree(self.root)

    def invoke(self, *extra, proof="preflight.json", command=None, env=None):
        args = [sys.executable, str(LAUNCHER), "--copy-root", str(self.root),
                "--proof", str(self.root / "control" / proof), *extra]
        if command:
            args.extend(["--", *command])
        return subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, timeout=30, env=env)

    def test_preflight_adds_kernel_filter_and_denies_every_network_call(self):
        result = self.invoke("--preflight")
        self.assertEqual(result.returncode, 0, result.stderr)
        proof = json.loads((self.root / "control" / "preflight.json").read_text())
        self.assertEqual(proof["mode"], "seccomp")
        self.assertTrue(proof["preflightOnly"])
        self.assertTrue(proof["networkFdsClosed"])
        self.assertTrue(proof["noNewPrivs"])
        self.assertEqual(proof["seccompMode"], 2)
        self.assertEqual(proof["filterEvidence"]["afterFilterCount"],
                         proof["filterEvidence"]["beforeFilterCount"] + 1)
        self.assertTrue(all(proof["kernelProbe"]["syscallsDeniedWithEperm"].values()))
        self.assertTrue(proof["kernelProbe"]["tcpSocketDenied"])
        self.assertTrue(proof["kernelProbe"]["udpSocketDenied"])
        self.assertFalse(proof["unrestrictedFallbackAllowed"])

    def test_exec_node_keeps_pid_and_inherits_filter_with_environment_scrubbed(self):
        self.assertTrue(NODE and Path(NODE).is_file(), "Pass a real Linux --node path")
        target = self.root / "control" / "synthetic-node-result.json"
        safe_env = {"PATH": "/usr/bin:/bin", "NODE_OPTIONS": "--require=/definitely/nonexistent-preload.js"}
        result = self.invoke("--code-root", str(self.code), "--guard-sha256", self.sha,
                             "--node-sha256", NODE_SHA, "--node-max-old-space-size", "768",
                             proof="exec.json", command=[NODE, str(self.guard),
                             str(self.root / "control" / "exec.json"), str(target)], env=safe_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(target.read_text())
        self.assertEqual(output["pid"], output["proofPid"])
        self.assertTrue(output["execInheritedKernelFilter"])
        proof = json.loads((self.root / "control" / "exec.json").read_text())
        self.assertEqual(proof["guardSha256"], self.sha)
        self.assertTrue(proof["environmentSanitizedForExec"])
        self.assertEqual(proof["nodeSha256"], NODE_SHA)
        self.assertEqual(proof["nodeMaxOldSpaceSizeMiB"], 768)

    def test_existing_proof_never_overwritten(self):
        proof = self.root / "control" / "preflight.json"
        proof.write_bytes(b"original-evidence")
        result = self.invoke("--preflight")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_PROOF_ALREADY_EXISTS", result.stderr)
        self.assertEqual(proof.read_bytes(), b"original-evidence")

    def test_inherited_socket_fd_is_closed_before_filter_or_exec(self):
        left, right = socket.socketpair()
        try:
            proof = self.root / "control" / "inherited-fd.json"
            result = subprocess.run([sys.executable, str(LAUNCHER), "--copy-root", str(self.root),
                "--proof", str(proof), "--preflight"], stdin=subprocess.DEVNULL,
                capture_output=True, text=True, timeout=30, pass_fds=(right.fileno(),))
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(proof.read_text())
            self.assertGreaterEqual(value["inheritedNonStandardFdsClosed"], 1)
            self.assertEqual(value["inheritedSocketFdsClosed"], 1)
            self.assertEqual(value["nonStandardFdsRemainingBeforeExec"], 0)
        finally:
            left.close()
            right.close()

    def test_symlink_control_is_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "control").rmdir()
        (self.root / "control").symlink_to(outside, target_is_directory=True)
        result = self.invoke("--preflight")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_SYMLINK_PATH", result.stderr)
        self.assertFalse((outside / "preflight.json").exists())

    def test_bad_guard_sha_blocks_before_proof_and_child(self):
        result = self.invoke("--code-root", str(self.code), "--guard-sha256", "0" * 64,
                             "--node-sha256", NODE_SHA,
                             command=[NODE, str(self.guard)])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_GUARD_SHA_MISMATCH", result.stderr)
        self.assertFalse((self.root / "control" / "preflight.json").exists())

    def test_wrong_node_sha_and_untrusted_guard_mode_fail_closed(self):
        result = self.invoke("--code-root", str(self.code), "--guard-sha256", self.sha,
                             "--node-sha256", "0" * 64, command=[NODE, str(self.guard)])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_NODE_SHA_MISMATCH", result.stderr)
        self.guard.chmod(0o666)
        result = self.invoke("--code-root", str(self.code), "--guard-sha256", self.sha,
                             "--node-sha256", NODE_SHA, command=[NODE, str(self.guard)])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_EXECUTION_FILE_NOT_TRUSTED", result.stderr)
        self.assertFalse((self.root / "control" / "preflight.json").exists())

    def test_heap_bound_cannot_be_disabled_or_expanded(self):
        for value in ("0", "127", "1025"):
            result = self.invoke("--preflight", "--node-max-old-space-size", value)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ISOLATION_NODE_HEAP_BOUNDS", result.stderr)
        self.assertFalse((self.root / "control" / "preflight.json").exists())

    def test_arbitrary_executable_or_missing_guard_contract_is_rejected(self):
        result = self.invoke("--code-root", str(self.code), "--guard-sha256", self.sha,
                             "--node-sha256", NODE_SHA,
                             command=[sys.executable, str(self.guard)])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_GUARDED_COMMAND_REQUIRED", result.stderr)
        missing = self.invoke(command=[NODE, str(self.guard)])
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse((self.root / "control" / "preflight.json").exists())

    def test_preflight_cannot_execute_child(self):
        result = self.invoke("--preflight", command=[NODE, str(self.guard)])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_PREFLIGHT_MUST_NOT_EXEC", result.stderr)

    def test_absent_libseccomp_is_fail_closed_without_no_new_privs_change(self):
        spec = importlib.util.spec_from_file_location("isolated_launcher_fixture", LAUNCHER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        before = module.proc_status()
        with mock.patch.object(module.ctypes, "CDLL", side_effect=OSError("synthetic absent")):
            with self.assertRaises(module.IsolationError) as caught:
                module.add_network_filter()
        self.assertEqual(caught.exception.code, "ISOLATION_LIBSECCOMP_REQUIRED")
        self.assertEqual(module.proc_status(), before)

    def test_proof_path_outside_control_is_rejected(self):
        result = subprocess.run([sys.executable, str(LAUNCHER), "--copy-root", str(self.root),
            "--proof", str(self.root / "outside.json"), "--preflight"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATION_PROOF_OUTSIDE_CONTROL", result.stderr)
        self.assertFalse((self.root / "outside.json").exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True, help="Absolute regular Linux Node executable")
    settings, remaining = parser.parse_known_args()
    NODE = str(Path(settings.node).resolve())
    NODE_SHA = hashlib.sha256(Path(NODE).read_bytes()).hexdigest()
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
