"""Restart only this checkout's local backend, retaining its in-memory environment."""
import ctypes
from ctypes import wintypes
import pathlib
import struct
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
backend = root / 'backend'
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel.ReadProcessMemory.restype = wintypes.BOOL
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
nt = ctypes.WinDLL('ntdll')
nt.NtQueryInformationProcess.argtypes = [wintypes.HANDLE, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.c_void_p]

pid = int(sys.argv[1])
handle = kernel.OpenProcess(0x0400 | 0x0010, False, pid)
if not handle:
    raise ctypes.WinError(ctypes.get_last_error())
try:
    def read(address, size):
        buffer = ctypes.create_string_buffer(size)
        count = ctypes.c_size_t()
        if not kernel.ReadProcessMemory(handle, address, buffer, size, ctypes.byref(count)):
            raise ctypes.WinError(ctypes.get_last_error())
        return buffer.raw[:count.value]

    info = ctypes.create_string_buffer(48)
    if nt.NtQueryInformationProcess(handle, 0, info, 48, None) != 0:
        raise RuntimeError('Cannot inspect local backend')
    peb = struct.unpack_from('<Q', info.raw, 8)[0]
    parameters = struct.unpack('<Q', read(peb + 0x20, 8))[0]
    def unicode_field(offset):
        length, _, pointer = struct.unpack('<HH4xQ', read(parameters + offset, 16))
        return read(pointer, length).decode('utf-16-le')

    cwd = pathlib.Path(unicode_field(0x38)).resolve()
    command = unicode_field(0x70)
    if cwd != backend.resolve() or 'dist/main.js' not in command:
        raise RuntimeError('Target is not this checkout backend')
    address = struct.unpack('<Q', read(parameters + 0x80, 8))[0]
    raw = b''
    while len(raw) < 1024 * 1024:
        chunk = read(address + len(raw), 4096 - ((address + len(raw)) % 4096))
        raw += chunk
        end = next((i for i in range(0, len(raw) - 3, 2) if raw[i:i+4] == b'\0\0\0\0'), None)
        if end is not None:
            raw = raw[:end]
            break
    else:
        raise RuntimeError('Environment is not bounded')
    environment = {}
    for entry in raw.decode('utf-16-le').split('\0'):
        if '=' in entry and not entry.startswith('='):
            key, value = entry.split('=', 1)
            environment[key] = value
finally:
    kernel.CloseHandle(handle)

print('Verified local backend directory and captured environment without writing credentials.')
if '--restart' in sys.argv:
    subprocess.run(['taskkill', '/PID', str(pid), '/F'], check=True, capture_output=True)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    with (root / 'backend-order-arrival.log').open('ab') as out, (root / 'backend-order-arrival.err.log').open('ab') as err:
        process = subprocess.Popen(['node', 'dist/main.js'], cwd=backend, env=environment,
                                   stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                                   startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)
    print('Local backend restarted:', process.pid)
