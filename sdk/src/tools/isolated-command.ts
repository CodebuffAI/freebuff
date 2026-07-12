/**
 * Windows Job Object protection for child processes.
 *
 * On Windows, wraps a child process in a Job Object with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so that if the parent dies
 * unexpectedly (crash, taskkill /F), Windows terminates all children
 * automatically.
 *
 * Uses Bun.FFI to call kernel32.dll directly. Falls back gracefully
 * (returns null) if FFI is unavailable or fails.
 */

import * as os from 'os'

// ─── Bun.FFI — lazily loaded ────────────────────────────────────────────────

let kernel32: Record<string, (...args: any[]) => any> | null = null
let ffiPtr: ((buf: Buffer) => bigint) | null = null

function ensureFFI(): boolean {
  if (kernel32) return true
  try {
    const ffi = require('bun:ffi') as {
      dlopen: (lib: string, symbols: Record<string, any>) => { symbols: Record<string, any> }
      FFIType: { pointer: string; bool: string; u32: string; i32: string }
      ptr: (buf: Buffer) => bigint
    }

    const lib = ffi.dlopen('kernel32.dll', {
      CreateJobObjectW: {
        args: [ffi.FFIType.pointer, ffi.FFIType.pointer],
        returns: ffi.FFIType.pointer,
      },
      AssignProcessToJobObject: {
        args: [ffi.FFIType.pointer, ffi.FFIType.pointer],
        returns: ffi.FFIType.bool,
      },
      SetInformationJobObject: {
        args: [ffi.FFIType.pointer, ffi.FFIType.i32, ffi.FFIType.pointer, ffi.FFIType.i32],
        returns: ffi.FFIType.bool,
      },
      CloseHandle: {
        args: [ffi.FFIType.pointer],
        returns: ffi.FFIType.bool,
      },
      OpenProcess: {
        args: [ffi.FFIType.u32, ffi.FFIType.bool, ffi.FFIType.u32],
        returns: ffi.FFIType.pointer,
      },
    })
    kernel32 = lib.symbols
    ffiPtr = ffi.ptr
    return true
  } catch {
    kernel32 = null
    ffiPtr = null
    return false
  }
}

// ─── Win32 constants ────────────────────────────────────────────────────────

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000
const JobObjectBasicLimitInformation = 2
const PROCESS_SET_QUOTA_TERMINATE = 0x0000_1000 | 0x0000_0001

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wrap a child process in a Windows Job Object.
 *
 * The job is configured with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so that
 * when this process exits (normally or via crash/kill), Windows terminates
 * the child process automatically.
 *
 * Call immediately after spawn(). Returns a cleanup function to call when
 * the child exits naturally. Returns null if:
 * - Not on Windows
 * - Bun.FFI is unavailable
 * - Any FFI call fails (graceful degradation)
 *
 * @param childPid – PID of the child process to protect.
 */
export function protectChildWithJob(childPid: number): (() => void) | null {
  if (os.platform() !== 'win32') return null
  if (!ensureFFI() || !kernel32 || !ffiPtr) return null

  try {
    const k32 = kernel32
    const ptr = ffiPtr

    // 1. Create an unnamed job object
    const jobHandle = BigInt(k32.CreateJobObjectW(0n, 0n))
    if (!jobHandle) return null

    // 2. Set JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    // JOBOBJECT_BASIC_LIMIT_INFORMATION: 48 bytes, LimitFlags at offset 16
    const limitInfo = Buffer.alloc(48)
    limitInfo.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)

    const limitOk = k32.SetInformationJobObject(
      jobHandle,
      JobObjectBasicLimitInformation,
      ptr(limitInfo),
      48,
    )

    if (!limitOk) {
      k32.CloseHandle(jobHandle)
      return null
    }

    // 3. Open child process with minimal rights for job assignment
    const hProcess = BigInt(k32.OpenProcess(PROCESS_SET_QUOTA_TERMINATE, false, childPid))
    if (!hProcess) {
      k32.CloseHandle(jobHandle)
      return null
    }

    // 4. Assign process to the job
    const assigned = k32.AssignProcessToJobObject(jobHandle, hProcess)
    k32.CloseHandle(hProcess)

    if (!assigned) {
      k32.CloseHandle(jobHandle)
      return null
    }

    // Return cleanup: close job handle when child exits naturally
    return () => {
      try { k32.CloseHandle(jobHandle) } catch { /* ignore */ }
    }
  } catch {
    // FFI can throw on type marshalling errors. Swallow gracefully.
    return null
  }
}
