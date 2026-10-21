fn main() {
    // sqlx::migrate! embeds SQL at compile time. Cargo must rebuild when SQL is
    // added or edited, otherwise a fresh database can silently miss migrations.
    println!("cargo:rerun-if-changed=../../migrations");
}
