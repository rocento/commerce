//! Generate local performance fixtures with the exact production encoder.
use api_gateway::public_commerce::images::derive;
use serde_json::json;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = root.join("output/electronics-performance/images");
    std::fs::create_dir_all(&output)?;
    let mut manifest = Vec::new();
    for (name, id) in [
        ("phone", "ee139d18-0f50-4a0e-be41-344f5f60662b"),
        ("headphones", "35c980c7-20c0-4c93-ad27-8ef824f955f5"),
        ("laptop", "be6297ac-1403-436f-a495-114318fe08ac"),
        ("appliance", "ab1195e5-48f5-40ec-abc1-5984bc063175"),
    ] {
        let source = root.join(format!("commerce-assets/demo/electronics/{name}.png"));
        let original = std::fs::read(source)?;
        let image = derive(&original)?;
        let mut variants = Vec::new();
        for (candidate, bytes) in image.variants {
            let path = output.join(format!("{name}-{}.webp", candidate.width));
            std::fs::write(path, &bytes)?;
            variants.push(
                json!({"width":candidate.width,"height":candidate.height,"bytes":bytes.len()}),
            );
        }
        manifest.push(json!({"id":id,"name":name,"original_bytes":original.len(),"width":image.width,"height":image.height,"variants":variants}));
    }
    std::fs::write(
        output.parent().unwrap().join("image-budget.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&manifest)?);
    Ok(())
}
