//! Repeatable per-installation baseline/catalog onboarding, without demo merchandise.
use domain_attributes::{industry, Service};
use serde_json::json;

const HELP: &str = "install-catalog-data [--list] [--install-core] [--industry CODE] [--apply]\n\nNo flags that write are implicit. --install-core requires --apply and runs the\nplatform's versioned migrations. --industry previews the target's template;\n--apply explicitly installs it. DATABASE_URL identifies exactly one client.\nAn already configured matching industry is preserved; switching industries\nrequires the Admin preview/apply workflow.";

#[derive(Default)]
struct Options {
    list: bool,
    core: bool,
    industry: Option<String>,
    apply: bool,
}
fn parse(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut result = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--list" => result.list = true,
            "--install-core" => result.core = true,
            "--apply" => result.apply = true,
            "--industry" => {
                let code = args.next().ok_or("--industry requires a code")?;
                if code.starts_with('-') || code.is_empty() || result.industry.is_some() {
                    return Err("Specify one industry code".into());
                }
                result.industry = Some(code);
            }
            _ => return Err(format!("Unknown argument: {arg}\n{HELP}")),
        }
    }
    if result.list && (result.core || result.apply || result.industry.is_some()) {
        return Err("Use --list by itself".into());
    }
    if result.core && !result.apply {
        return Err("--install-core requires --apply to run migrations".into());
    }
    if !result.list && !result.core && result.industry.is_none() {
        return Err(HELP.into());
    }
    Ok(result)
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
    let options = parse(std::env::args().skip(1))?;
    if options.list {
        println!("{}", serde_json::to_string_pretty(&industry::templates().iter().map(|p|json!({"code":p.code,"name":p.name,"version":p.version,"attributes":p.template.len()})).collect::<Vec<_>>())?);
        return Ok(());
    }
    let pool = infra_db::connect(&std::env::var("DATABASE_URL")?).await?;
    if options.core {
        infra_db::migrate(&pool).await?;
        println!("Core data installed: versioned platform schema, core product fields, roles/permissions, default inventory source/stock/channel, and catalog configuration. Existing migrations are not replayed.");
    }
    if let Some(code) = options.industry {
        let service = Service { pool };
        let profile = service
            .profiles()
            .await?
            .into_iter()
            .find(|p| p.code == code)
            .ok_or(
                "Unknown industry; use --list for built-ins or a custom profile code from Admin",
            )?;
        let preview = service.preview_industry(profile.id).await?;
        println!("{}", serde_json::to_string_pretty(&preview)?);
        if !options.apply {
            println!("Preview only. Rerun with --apply to confirm installation of this industry's definitions, managed options, groups and default attribute set.");
            return Ok(());
        }
        // Onboarding is create-once. Re-running provisioning must preserve customization,
        // including changed set membership and disabled definitions.
        let configuration = service
            .onboard_industry(profile.id, preview.configuration.version)
            .await?;
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"status":"installed","configuration":configuration,"note":"Existing matching industry customizations are preserved. No demo products or theme assignments are installed."})
            )?
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(args: &[&str]) -> Result<Options, String> {
        parse(args.iter().map(|s| s.to_string()))
    }
    #[test]
    fn writes_require_explicit_apply_and_valid_arguments() {
        assert!(options(&["--install-core"]).is_err());
        assert!(options(&["--apply"]).is_err());
        assert!(options(&["--industry", "--apply"]).is_err());
        assert!(options(&["--list", "--apply"]).is_err());
        assert!(options(&["--unknown"]).is_err());
        assert!(!options(&["--industry", "jewelry"]).unwrap().apply);
        assert!(
            options(&["--install-core", "--industry", "jewelry", "--apply"])
                .unwrap()
                .core
        );
    }
}
