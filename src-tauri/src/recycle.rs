//! The real Recycle Bin for discard (`gitr_core::repo::Bin`).

use std::path::{Component, Path, PathBuf, Prefix};

use gitr_core::repo::Bin;

/// Moves files to the Windows Recycle Bin via the `trash` crate.
///
/// Only files on **local fixed drives** are handed to the shell: on network, removable and other
/// drives Windows has no Recycle Bin and the shell would delete permanently instead. Such files
/// are refused up front (left untouched), so the user is asked before anything is lost.
pub struct RecycleBin;

impl Bin for RecycleBin {
    fn move_to_bin(&self, files: &[PathBuf]) -> Vec<Result<(), String>> {
        let mut results: Vec<Option<Result<(), String>>> = files.iter().map(|f| has_recycle_bin(f).err().map(Err)).collect();
        let eligible: Vec<&PathBuf> = files.iter().zip(&results).filter(|(_, r)| r.is_none()).map(|(f, _)| f).collect();
        if !eligible.is_empty() && trash::delete_all(&eligible).is_err() {
            // The batch failed part-way; find out file by file what still needs moving.
            for (file, result) in files.iter().zip(results.iter_mut()) {
                if result.is_none() && file.symlink_metadata().is_ok() {
                    *result = Some(trash::delete(file).map_err(|e| e.to_string()));
                }
            }
        }
        results.into_iter().map(|r| r.unwrap_or(Ok(()))).collect()
    }
}

/// Ok when `path` is on a drive that has a Recycle Bin (a local fixed disk).
fn has_recycle_bin(path: &Path) -> Result<(), String> {
    let full = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let letter = match full.components().next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::Disk(l) | Prefix::VerbatimDisk(l) => l as char,
            _ => return Err("network locations have no Recycle Bin".into()),
        },
        _ => return Err("not a drive path".into()),
    };
    match drive_type(letter) {
        DriveType::Fixed => Ok(()),
        DriveType::Remote => Err(format!("{letter}: is a network drive, which has no Recycle Bin")),
        DriveType::Other => Err(format!("{letter}: has no Recycle Bin (removable or virtual drive)")),
    }
}

// Only Windows reports the other kinds; elsewhere every drive counts as fixed.
#[cfg_attr(not(windows), allow(dead_code))]
enum DriveType {
    Fixed,
    Remote,
    Other,
}

#[cfg(windows)]
fn drive_type(letter: char) -> DriveType {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(Some(0)).collect();
    // SAFETY: `root` is a NUL-terminated UTF-16 string that outlives the call.
    match unsafe { GetDriveTypeW(root.as_ptr()) } {
        DRIVE_FIXED => DriveType::Fixed,
        DRIVE_REMOTE => DriveType::Remote,
        _ => DriveType::Other,
    }
}

#[cfg(not(windows))]
fn drive_type(_letter: char) -> DriveType {
    DriveType::Fixed
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_refused_without_touching_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let r = RecycleBin.move_to_bin(&[tmp.path().join("missing.txt")]);
        assert!(r[0].is_err());
    }

    #[test]
    fn network_paths_are_refused() {
        assert!(has_recycle_bin(Path::new(r"\\server\share\x.txt")).is_err());
    }

    /// Uses the real Recycle Bin, then purges exactly the item it created.
    /// Run with `cargo test -p gitr -- --ignored recycle`.
    #[test]
    #[ignore = "touches the real Recycle Bin"]
    fn recycle_real_bin_keeps_name_and_location() {
        let tmp = tempfile::tempdir().unwrap();
        let name = format!("gitr-test-{}.txt", std::process::id());
        let file = tmp.path().join(&name);
        std::fs::write(&file, "recoverable").unwrap();
        let missing = tmp.path().join("missing.txt");

        // A batch with one bad entry still moves the good one (per-file fallback).
        let r = RecycleBin.move_to_bin(&[file.clone(), missing]);
        assert_eq!(r[0], Ok(()), "{r:?}");
        assert!(r[1].is_err());
        assert!(!file.exists());

        let parent = std::fs::canonicalize(tmp.path()).unwrap();
        let strip = |p: &Path| p.to_string_lossy().trim_start_matches(r"\\?\").to_lowercase();
        let items: Vec<_> = trash::os_limited::list()
            .unwrap()
            .into_iter()
            .filter(|i| i.name.to_string_lossy() == name)
            .collect();
        assert_eq!(items.len(), 1, "exactly our file in the bin");
        assert_eq!(strip(&items[0].original_parent), strip(&parent), "original location kept");
        trash::os_limited::purge_all(items).unwrap();
    }
}
