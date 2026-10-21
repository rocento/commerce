//! Operator-only image preparation. Preview by default; deployment explicitly applies one batch.
use api_gateway::public_commerce::image_preparation;
use serde_json::json;

const HELP: &str = "prepare-storefront-images [--apply] [--limit 1..500]\nPrepare missing WebP candidates for currently referenced public storefront images.\nPreview by default. DATABASE_URL scopes exactly one installation. Originals, private\nmedia, products, themes and assignments are preserved. Reruns skip completed images.";

fn options(args: impl IntoIterator<Item = String>) -> Result<(bool, i64), String> {
    let mut args = args.into_iter();
    let (mut apply, mut limit) = (false, 100);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--apply" => apply = true,
            "--limit" => {
                limit = args
                    .next()
                    .ok_or("--limit requires a number")?
                    .parse()
                    .map_err(|_| "Invalid image limit")?;
                if !(1..=500).contains(&limit) {
                    return Err("Image limit must be 1..500".into());
                }
            }
            _ => return Err(format!("Unknown option: {arg}\n{HELP}")),
        }
    }
    Ok((apply, limit))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "--help" || arg == "-h")
    {
        println!("{HELP}");
        return Ok(());
    }
    let (apply, limit) = options(std::env::args().skip(1))?;
    let pool = infra_db::connect(&std::env::var("DATABASE_URL")?).await?;
    let images = image_preparation::candidates(&pool, limit).await?;
    let pending = image_preparation::pending(&pool).await?;
    if !apply {
        println!(
            "{}",
            json!({"mode":"preview","pending":pending,"selected":images.iter().map(|i|i.id).collect::<Vec<_>>(),"limit":limit})
        );
        return Ok(());
    }
    if images.is_empty() {
        println!("{}", json!({"processed":0,"remaining":pending}));
        return Ok(());
    }
    let store = infra_media::Store::new(
        std::env::var("S3_ENDPOINT")?,
        &std::env::var("S3_ACCESS_KEY")?,
        &std::env::var("S3_SECRET_KEY")?,
    )
    .map_err(|_| "Image storage configuration is invalid")?;
    let (mut processed, mut failed) = (0, Vec::new());
    for candidate in images {
        let id = candidate.id;
        match tokio::time::timeout(
            std::time::Duration::from_secs(120),
            image_preparation::prepare(&pool, &store, candidate),
        )
        .await
        {
            Ok(Ok(())) => processed += 1,
            // Provider errors may contain private storage paths; report identifiers only.
            _ => failed.push(id),
        }
    }
    println!(
        "{}",
        json!({"processed":processed,"failed":failed,"remaining":image_preparation::pending(&pool).await?})
    );
    if !failed.is_empty() {
        return Err(
            "Image preparation failed; originals retained. Inspect the reported media and retry."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_is_preview_by_default_and_batches_are_bounded() {
        let parse = |args: &[&str]| options(args.iter().map(|arg| arg.to_string()));
        assert_eq!(parse(&[]).unwrap(), (false, 100));
        assert_eq!(parse(&["--apply", "--limit", "20"]).unwrap(), (true, 20));
        for args in [
            vec!["--limit", "0"],
            vec!["--limit", "501"],
            vec!["--limit"],
            vec!["--all"],
        ] {
            assert!(parse(&args).is_err());
        }
    }
}
