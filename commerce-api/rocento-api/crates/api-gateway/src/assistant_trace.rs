//! Private, bounded trace links. Trace headers never grant authority.
use axum::http::HeaderMap;
use std::time::Duration;
use uuid::Uuid;

pub fn dispatch(request: Uuid) -> String {
    format!("1/{}/{}", request, Uuid::new_v4())
}

pub fn context(headers: &HeaderMap, request: Uuid) -> Option<String> {
    if headers.get_all("x-commerce-trace-request").iter().count() != 1 {
        return None;
    }
    let value = headers.get("x-commerce-trace-request")?.to_str().ok()?;
    if value.len() > 160 {
        return None;
    }
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() != 3
        || parts[0] != "1"
        || parts[1] != request.to_string()
        || parts[2].is_empty()
        || parts[2].len() > 64
        || !parts[2]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    Some(value.to_owned())
}

pub fn reply(context: &str, elapsed: Duration) -> String {
    format!(
        "{}/{}/{:.3}",
        context,
        Uuid::new_v4(),
        elapsed.as_secs_f64() * 1000.0
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_is_bounded_and_request_scoped() {
        let request = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        for value in [format!("1/{request}/span-1"), dispatch(request)] {
            headers.insert("x-commerce-trace-request", value.parse().unwrap());
            assert_eq!(context(&headers, request), Some(value));
            assert!(context(&headers, Uuid::new_v4()).is_none());
        }
        for value in [
            format!("2/{request}/span-1"),
            format!("1/{request}/"),
            format!("1/{request}/{}", "a".repeat(65)),
            format!("1/{request}/span/extra"),
        ] {
            headers.insert("x-commerce-trace-request", value.parse().unwrap());
            assert!(context(&headers, request).is_none());
        }
        assert!(
            reply(&format!("1/{request}/span-1"), Duration::from_millis(12)).ends_with("/12.000")
        );
    }
}
