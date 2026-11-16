#!/usr/bin/python3
"""Fixed reviewed B3 rename only; no overwrite, copy, unlink, or fallback."""
import ctypes
import hashlib
import json
import os
import stat
import sys


def identity(value):
    return {"dev": str(value.st_dev), "ino": str(value.st_ino), "size": str(value.st_size),
            "mtimeNs": str(value.st_mtime_ns), "ctimeNs": str(value.st_ctime_ns),
            "nlink": str(value.st_nlink), "mode": str(value.st_mode),
            "uid": str(value.st_uid), "gid": str(value.st_gid)}


def require(value):
    if not value:
        raise RuntimeError("B3_RENAME_PRECONDITION")


def run():
    raw = sys.stdin.buffer.read(16385)
    require(len(raw) <= 16384)
    value = json.loads(raw)
    require(set(value) == {"sourceDirectory", "destinationDirectory", "sourceName", "destinationName", "sourceStat", "sourceDirectoryStat", "destinationDirectoryStat", "sourceSha256"})
    require(value["sourceName"] == "prepared-conversion-lock.json" and value["destinationName"] == "retired-original.json")
    source_dir = os.open(value["sourceDirectory"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    destination_dir = os.open(value["destinationDirectory"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    source = None
    try:
        require(identity(os.fstat(source_dir)) == value["sourceDirectoryStat"])
        require(identity(os.fstat(destination_dir)) == value["destinationDirectoryStat"])
        source = os.open(value["sourceName"], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_dir)
        before = os.fstat(source)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and identity(before) == value["sourceStat"])
        body = os.read(source, 317)
        require(len(body) == 316 and hashlib.sha256(body).hexdigest() == value["sourceSha256"])
        require(identity(os.fstat(source)) == value["sourceStat"])
        require(identity(os.stat(value["sourceName"], dir_fd=source_dir, follow_symlinks=False)) == value["sourceStat"])
        require(identity(os.fstat(source_dir)) == value["sourceDirectoryStat"])
        require(identity(os.fstat(destination_dir)) == value["destinationDirectoryStat"])
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(source_dir, value["sourceName"].encode(), destination_dir, value["destinationName"].encode(), 1)
        if result != 0:
            raise OSError(ctypes.get_errno(), "B3_RENAME_KERNEL_HOLD")
        after = os.stat(value["destinationName"], dir_fd=destination_dir, follow_symlinks=False)
        require(all(identity(after)[key] == value["sourceStat"][key] for key in ("dev", "ino", "size", "mtimeNs", "nlink", "mode", "uid", "gid")))
        os.lseek(source, 0, os.SEEK_SET)
        require(hashlib.sha256(os.read(source, 317)).hexdigest() == value["sourceSha256"])
        os.fsync(source_dir)
        os.fsync(destination_dir)
        sys.stdout.write('{"status":"renamed","noReplace":true}\n')
    finally:
        if source is not None:
            os.close(source)
        os.close(source_dir)
        os.close(destination_dir)


try:
    run()
except Exception as error:
    sys.stdout.write(json.dumps({"status": "held", "code": "B3_RENAME_FAILED", "errno": error.errno if isinstance(error, OSError) else None}) + "\n")
    sys.exit(2)
