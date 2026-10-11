//! Windows Job Objects: git and every process it starts, so Stop can end them all.
//!
//! `taskkill /T` follows parent-process links, which Git for Windows' shell (MSYS) breaks:
//! it emulates exec by starting a new Windows process, so a hook's commands have a parent
//! that no longer exists and survive. A process started by a process in a job joins that
//! job, however it was started, so terminating the job reaches them.
//!
//! git must be in its job before it starts anything: `cmd\git.exe` is a launcher that starts
//! the real `git.exe` at once. So git is created suspended (`CREATE_SUSPENDED`), put in its job,
//! then resumed.

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next};
use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};
use windows::Win32::System::Threading::{OpenProcess, OpenThread, PROCESS_SET_QUOTA, PROCESS_TERMINATE, ResumeThread, THREAD_SUSPEND_RESUME};
use windows::core::PCWSTR;

/// `CREATE_SUSPENDED`: the process is created with its first thread paused (see `resume`).
pub const CREATE_SUSPENDED: u32 = 0x0000_0004;

/// Starts a process created with `CREATE_SUSPENDED`: resumes its threads (a new process has
/// one). Windows has no documented call to resume a whole process, so its threads are found in
/// a thread snapshot. Returns false if nothing could be resumed.
pub fn resume(pid: u32) -> bool {
    // SAFETY: plain Win32 calls; the snapshot and each thread handle are closed before returning.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else { return false };
        let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
        let mut resumed = false;
        let mut more = Thread32First(snapshot, &mut entry).is_ok();
        while more {
            if entry.th32OwnerProcessID == pid
                && let Ok(thread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
            {
                // The previous suspend count, or u32::MAX on failure.
                resumed |= ResumeThread(thread) != u32::MAX;
                let _ = CloseHandle(thread);
            }
            more = Thread32Next(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        resumed
    }
}

/// A Windows Job Object. Processes stay in it after it is dropped; only `terminate` ends them.
pub struct Job(HANDLE);

// SAFETY: a job handle can be used and closed from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    /// A new job holding process `pid` (and, from now on, every process it starts). None if
    /// Windows refuses, for example on a system without nested jobs; callers fall back.
    pub fn holding(pid: u32) -> Option<Job> {
        // SAFETY: plain Win32 calls on handles this function owns; each is closed on every path
        // (the job by `Job`'s Drop).
        unsafe {
            // No limits set, deliberately not JOB_OBJECT_LIMIT_BREAKAWAY_OK: Cygwin, and so Git for
            // Windows' MSYS shell, starts every process with CREATE_BREAKAWAY_FROM_JOB when its job
            // allows breakaway, which would take a hook's commands out of the job again.
            let job = Job(CreateJobObjectW(None, PCWSTR::null()).ok()?);
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).ok()?;
            let assigned = AssignProcessToJobObject(job.0, process);
            let _ = CloseHandle(process);
            assigned.ok()?;
            Some(job)
        }
    }

    /// Ends every process in the job.
    pub fn terminate(&self) {
        // SAFETY: the handle is open until Drop.
        let _ = unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Closing the handle leaves the processes running (no KILL_ON_JOB_CLOSE): after a normal
        // exit, whatever git left running on purpose (such as an fsmonitor daemon) stays.
        // SAFETY: owned handle, closed once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}
