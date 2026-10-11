//! Windows Job Objects: git and every process it starts, so Stop can end them all.
//!
//! `taskkill /T` follows parent-process links, which Git for Windows' shell (MSYS) breaks:
//! it emulates exec by starting a new Windows process, so a hook's commands have a parent
//! that no longer exists and survive. A process started by a process in a job joins that
//! job, however it was started, so terminating the job reaches them.

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
use windows::core::PCWSTR;

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
            let job = Job(CreateJobObjectW(None, PCWSTR::null()).ok()?);
            // A program that explicitly asks to outlive its parent (CREATE_BREAKAWAY_FROM_JOB)
            // may; without this, Windows would refuse to start it at all. Everything else stays in.
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
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
