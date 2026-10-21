//! Reversible spreadsheet-safe text encoding shared by both CSV exporters.
fn needs_prefix(value: &str) -> bool {
    value.starts_with(['\t', '\r', '\n', '\''])
        || value.trim_start().starts_with(['=', '+', '-', '@', '\''])
}
pub fn escape(value: &str) -> String {
    if needs_prefix(value) {
        format!("'{value}")
    } else {
        value.into()
    }
}
pub fn unescape(value: &str) -> String {
    match value.strip_prefix('\'') {
        Some(rest) if needs_prefix(rest) => rest.into(),
        _ => value.into(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formulas_controls_and_apostrophes_round_trip() {
        for value in [
            "=SUM(1,2)",
            " +123",
            "\tplain",
            "\rplain",
            "\nplain",
            "  @SUM(A1)",
            "\u{2003}=1",
            "'literal",
            " '=1",
            "-1",
            "\t=1",
        ] {
            assert!(escape(value).starts_with('\''), "{value:?}");
            assert_eq!(unescape(&escape(value)), value);
        }
        for value in [
            "ordinary",
            " leading space",
            "Tea, coffee",
            "Line1\nLine2",
            "العربية",
            "",
        ] {
            assert_eq!(escape(value), value);
            assert_eq!(unescape(&escape(value)), value);
        }
    }
}
