//! Argon2id (RFC 9106) for the browser. The page passes byte buffers through `eh_alloc`
//! and reads the tag back from the output buffer; no JavaScript glue or bindings are needed.

use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};

/// Derive an Argon2id tag. Returns 0 on success or a negative error code.
pub fn derive(password: &[u8], salt: &[u8], secret: &[u8], ad: &[u8], m_kib: u32, t: u32, p: u32, out: &mut [u8]) -> i32 {
    let mut builder = ParamsBuilder::new();
    builder.m_cost(m_kib).t_cost(t).p_cost(p).output_len(out.len());
    if !ad.is_empty() {
        match AssociatedData::new(ad) {
            Ok(data) => { builder.data(data); }
            Err(_) => return -2,
        }
    }
    let params = match builder.build() { Ok(p) => p, Err(_) => return -1 };
    let hasher = if secret.is_empty() {
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
    } else {
        match Argon2::new_with_secret(secret, Algorithm::Argon2id, Version::V0x13, params) {
            Ok(h) => h,
            Err(_) => return -3,
        }
    };
    match hasher.hash_password_into(password, salt, out) { Ok(()) => 0, Err(_) => -4 }
}

#[no_mangle]
pub extern "C" fn eh_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `eh_alloc` with the same `len`. The buffer is zeroed before release.
#[no_mangle]
pub unsafe extern "C" fn eh_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() { return; }
    let mut buf = Vec::from_raw_parts(ptr, len.max(1), len.max(1));
    for b in buf.iter_mut() { core::ptr::write_volatile(b, 0); }
    drop(buf);
}

/// # Safety
/// Every pointer/length pair must describe memory obtained from `eh_alloc`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn eh_argon2id(
    pwd: *const u8, pwd_len: usize, salt: *const u8, salt_len: usize,
    secret: *const u8, secret_len: usize, ad: *const u8, ad_len: usize,
    m_kib: u32, t: u32, p: u32, out: *mut u8, out_len: usize,
) -> i32 {
    let slice = |ptr: *const u8, len: usize| if len == 0 { &[][..] } else { core::slice::from_raw_parts(ptr, len) };
    let out = core::slice::from_raw_parts_mut(out, out_len);
    derive(slice(pwd, pwd_len), slice(salt, salt_len), slice(secret, secret_len), slice(ad, ad_len), m_kib, t, p, out)
}

#[cfg(test)]
mod tests {
    use super::derive;

    #[test]
    fn rfc9106_argon2id_vector() {
        let mut out = [0u8; 32];
        assert_eq!(derive(&[1; 32], &[2; 16], &[3; 8], &[4; 12], 32, 3, 4, &mut out), 0);
        let expected = "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";
        let hex: String = out.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, expected);
    }
}
