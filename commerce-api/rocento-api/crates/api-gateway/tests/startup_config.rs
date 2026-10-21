use std::process::Command;

#[test]
fn invalid_security_settings_stop_before_connecting_or_migrating() {
    for (key, value, expected) in [
        ("COOKIE_SECURE", "false", "COOKIE_SECURE=true"),
        ("ALLOWED_ORIGINS", "*", "ALLOWED_ORIGINS"),
        (
            "STOREFRONT_URL",
            "http://shop.example.com",
            "STOREFRONT_URL",
        ),
        (
            "PASSWORD_HASH_MAX_CONCURRENCY",
            "0",
            "PASSWORD_HASH_MAX_CONCURRENCY",
        ),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_api-gateway"))
            .env_clear()
            .env(
                "DATABASE_URL",
                "postgres://unused:unused@127.0.0.1:1/unused",
            )
            .env("APP_ENV", "production")
            .env("AUTH_SECRET", "private-test-key-that-must-never-be-printed")
            .env("COOKIE_SECURE", "true")
            .env("STOREFRONT_URL", "https://shop.example.com")
            .env("ALLOWED_ORIGINS", "https://shop.example.com")
            .env("NOTIFICATION_MODE", "smtp")
            .env(key, value)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains(expected), "{key}: {stderr}");
        assert!(!stderr.contains("private-test-key"));
        assert!(!stderr.contains("unused:unused"));
        assert!(!stderr.contains("Connection refused"));
        assert!(output.stdout.is_empty());
    }
}
