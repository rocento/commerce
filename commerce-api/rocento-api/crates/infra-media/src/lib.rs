//! Private S3 storage; only validated catalog UUIDs are exposed through the gateway.
use s3::{creds::Credentials, Bucket, BucketConfiguration, Region};
use std::sync::Arc;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Clone)]
pub struct Store {
    bucket: Arc<Bucket>,
}
impl Store {
    pub fn new(endpoint: String, access: &str, secret: &str) -> Result<Self> {
        let credentials = Credentials::new(Some(access), Some(secret), None, None, None)?;
        let bucket = Bucket::new(
            "commerce-media",
            Region::Custom {
                region: "us-east-1".into(),
                endpoint,
            },
            credentials,
        )?
        .with_path_style();
        Ok(Self {
            bucket: Arc::new(*bucket),
        })
    }
    pub async fn initialize(&self) -> Result<()> {
        if !self.bucket.exists().await? {
            let response = Bucket::create_with_path_style(
                &self.bucket.name,
                self.bucket.region.clone(),
                self.bucket.credentials().await?,
                BucketConfiguration::default(),
            )
            .await?;
            if !(200..300).contains(&response.response_code) {
                return Err(
                    format!("S3 bucket creation failed: {}", response.response_code).into(),
                );
            }
        }
        Ok(())
    }
    pub async fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<()> {
        let r = self
            .bucket
            .put_object_with_content_type(key, bytes, content_type)
            .await?;
        if !(200..300).contains(&r.status_code()) {
            return Err("S3 upload failed".into());
        }
        Ok(())
    }
    pub async fn get(&self, key: &str) -> Result<Vec<u8>> {
        let r = self.bucket.get_object(key).await?;
        if r.status_code() != 200 {
            return Err("S3 read failed".into());
        }
        Ok(r.to_vec())
    }
    pub async fn delete(&self, key: &str) -> Result<()> {
        let r = self.bucket.delete_object(key).await?;
        if !(200..300).contains(&r.status_code()) {
            return Err("S3 delete failed".into());
        }
        Ok(())
    }
}
