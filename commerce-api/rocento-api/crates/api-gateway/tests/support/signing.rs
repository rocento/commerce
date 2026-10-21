use std::{
    io::Write,
    process::{Command, Stdio},
    sync::OnceLock,
};

fn assistant_key_pair() -> &'static (Vec<u8>, Vec<u8>) {
    static KEYS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    KEYS.get_or_init(|| {
        let generated = Command::new("openssl")
            .args([
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:2048",
            ])
            .output()
            .expect("OpenSSL is required to generate ephemeral test signing keys");
        assert!(
            generated.status.success(),
            "OpenSSL failed to generate an ephemeral test key"
        );

        let mut public = Command::new("openssl")
            .args(["pkey", "-pubout"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("OpenSSL is required to derive the test public key");
        public
            .stdin
            .take()
            .expect("OpenSSL stdin is piped")
            .write_all(&generated.stdout)
            .expect("write ephemeral test key to OpenSSL");
        let public = public
            .wait_with_output()
            .expect("OpenSSL should derive the ephemeral test public key");
        assert!(
            public.status.success(),
            "OpenSSL failed to derive the ephemeral test public key"
        );
        (generated.stdout, public.stdout)
    })
}

pub fn assistant_private_key() -> &'static [u8] {
    &assistant_key_pair().0
}

pub fn assistant_public_key() -> &'static [u8] {
    &assistant_key_pair().1
}
