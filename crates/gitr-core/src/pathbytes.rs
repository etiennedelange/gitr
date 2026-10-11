//! Lossless text for git output. Git paths are bytes; a name that isn't valid UTF-8 (a Latin-1
//! file on Linux or macOS) used to become `�` and could not be given back to git. Here each byte
//! that isn't valid UTF-8 becomes one private-use character, `U+F780..=U+F7FF` for `0x80..=0xFF`,
//! and [`to_os`] / [`to_bytes`] turn it back into the byte before the text reaches git or the
//! file system. Valid UTF-8 passes through untouched.

use std::ffi::OsString;

const BASE: u32 = 0xF700;

/// Decodes git output, keeping invalid bytes recoverable.
pub fn decode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for chunk in bytes.utf8_chunks() {
        out.push_str(chunk.valid());
        out.extend(chunk.invalid().iter().map(|&b| char::from_u32(BASE + b as u32).expect("private use")));
    }
    out
}

fn escaped_byte(c: char) -> Option<u8> {
    let n = c as u32;
    (BASE + 0x80..=BASE + 0xFF).contains(&n).then(|| (n - BASE) as u8)
}

/// The bytes git or the file system should see for `s`.
pub fn to_bytes(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut buf = [0u8; 4];
    for c in s.chars() {
        match escaped_byte(c) {
            Some(b) => out.push(b),
            None => out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes()),
        }
    }
    out
}

/// `s` as an argument or path. Windows paths are UTF-16 and git prints UTF-8 there, so nothing
/// needs restoring.
pub fn to_os(s: &str) -> OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(to_bytes(s))
    }
    #[cfg(not(unix))]
    {
        OsString::from(s)
    }
}

/// Text for showing to a person: escaped bytes become `�`.
pub fn display(s: &str) -> String {
    s.chars().map(|c| if escaped_byte(c).is_some() { '\u{FFFD}' } else { c }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_utf8_is_untouched_and_invalid_bytes_round_trip() {
        assert_eq!(decode("café ✓".as_bytes()), "café ✓");
        let raw = b"caf\xe9 \xff\xfe.txt";
        let text = decode(raw);
        assert_ne!(text, "caf\u{FFFD} \u{FFFD}\u{FFFD}.txt");
        assert_eq!(to_bytes(&text), raw);
        assert_eq!(display(&text), "caf\u{FFFD} \u{FFFD}\u{FFFD}.txt");
    }

    #[test]
    fn two_different_bad_bytes_stay_different() {
        assert_ne!(decode(b"a\xe9"), decode(b"a\xe8"));
    }
}
