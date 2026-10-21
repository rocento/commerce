//! Delivery area administration and cached availability reads.
use super::*;
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pin {
    pub latitude: f64,
    pub longitude: f64,
}
impl Pin {
    pub fn validate(self) -> Result<Self> {
        if !self.latitude.is_finite()
            || !self.longitude.is_finite()
            || !(-90.0..=90.0).contains(&self.latitude)
            || !(-180.0..=180.0).contains(&self.longitude)
        {
            return Err(invalid("Invalid delivery coordinates"));
        }
        Ok(self)
    }
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct AreaLink {
    pub stock_id: Uuid,
    pub priority: i32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AreaInput {
    pub name: String,
    #[serde(default)]
    pub center_lat: f64,
    #[serde(default)]
    pub center_lng: f64,
    #[serde(default = "legacy_radius")]
    pub radius_km: f64,
    #[serde(default)]
    pub boundary: Option<Vec<Pin>>,
    pub priority: i32,
    pub is_active: bool,
    pub stocks: Vec<AreaLink>,
}
#[derive(Serialize)]
pub struct Area {
    pub entity_id: i64,
    pub id: Uuid,
    #[serde(flatten)]
    pub input: AreaInput,
}
#[derive(Serialize)]
pub struct Delivery {
    pub configured: bool,
    pub deliverable: bool,
    pub area_id: Option<Uuid>,
}
/// Storefront-safe delivery-area information. Operational assignments and
/// boundaries stay private to the administration API.
#[derive(Serialize, FromRow)]
pub struct DeliveryAreaChoice {
    pub entity_id: i64,
    pub id: Uuid,
    pub name: String,
    pub center_lat: f64,
    pub center_lng: f64,
}
fn legacy_radius() -> f64 {
    1.0
}

impl Service {
    pub async fn delivery(&self, pin: Option<Pin>) -> Result<Delivery> {
        if let Some(p) = pin {
            p.validate()?;
        }
        let (configured,area_id):(bool,Option<Uuid>)=sqlx::query_as("SELECT fulfillment.geofencing(fulfillment.default_store()) AND EXISTS(SELECT 1 FROM inventory.delivery_areas),CASE WHEN fulfillment.global_delivery(fulfillment.default_store()) THEN NULL::uuid ELSE inventory.resolve_delivery_area($1,$2) END").bind(pin.map(|p|p.latitude)).bind(pin.map(|p|p.longitude)).fetch_one(&self.pool).await?;
        Ok(Delivery {
            configured,
            deliverable: !configured || area_id.is_some(),
            area_id,
        })
    }
    pub async fn areas(&self) -> Result<Vec<Area>> {
        type AreaRow = (
            Uuid,
            i64,
            String,
            f64,
            f64,
            f64,
            i32,
            bool,
            Option<sqlx::types::Json<Vec<Pin>>>,
        );
        let rows:Vec<AreaRow>=sqlx::query_as("SELECT id,entity_id,name,center_lat,center_lng,radius_km,priority,is_active,boundary FROM inventory.delivery_areas ORDER BY priority,name,id").fetch_all(&self.pool).await?;
        let mut out = vec![];
        for (
            id,
            entity_id,
            name,
            center_lat,
            center_lng,
            radius_km,
            priority,
            is_active,
            boundary,
        ) in rows
        {
            let stocks=sqlx::query_as("SELECT stock_id,priority FROM inventory.area_stock_links WHERE area_id=$1 ORDER BY priority,stock_id").bind(id).fetch_all(&self.pool).await?;
            out.push(Area {
                id,
                entity_id,
                input: AreaInput {
                    name,
                    center_lat,
                    center_lng,
                    radius_km,
                    boundary: boundary.map(|v| v.0),
                    priority,
                    is_active,
                    stocks,
                },
            });
        }
        Ok(out)
    }
    pub async fn delivery_choices(&self) -> Result<Vec<DeliveryAreaChoice>> {
        Ok(sqlx::query_as("SELECT id,entity_id,name,center_lat,center_lng FROM inventory.delivery_areas WHERE is_active ORDER BY priority,name,id").fetch_all(&self.pool).await?)
    }
    pub async fn save_area(&self, id: Option<Uuid>, mut i: AreaInput, actor: Uuid) -> Result<Uuid> {
        if let Some(points) = &i.boundary {
            validate_boundary(points)?;
            i.center_lat = points.iter().map(|p| p.latitude).sum::<f64>() / points.len() as f64;
            i.center_lng = points.iter().map(|p| p.longitude).sum::<f64>() / points.len() as f64;
            i.radius_km = 1.0;
        }
        Pin {
            latitude: i.center_lat,
            longitude: i.center_lng,
        }
        .validate()?;
        if i.name.trim().is_empty()
            || i.name.len() > 100
            || !i.radius_km.is_finite()
            || !(0.0..=2000.0).contains(&i.radius_km)
            || i.radius_km == 0.0
            || i.stocks.len() > 100
            || (i.is_active && i.stocks.is_empty())
            || i.stocks
                .iter()
                .map(|s| s.stock_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != i.stocks.len()
        {
            return Err(invalid(
                "Enter a name, radius up to 2000 km, and distinct stocks (required for active areas)",
            ));
        }
        let mut tx = begin(&self.pool).await?;
        if let Some(id) = id {
            if !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM inventory.delivery_areas WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
            {
                return Err(Error::NotFound);
            }
        }
        let id = id.unwrap_or_else(Uuid::new_v4);
        sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km,priority,is_active,boundary) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=$2,center_lat=$3,center_lng=$4,radius_km=$5,priority=$6,is_active=$7,boundary=$8").bind(id).bind(i.name.trim()).bind(i.center_lat).bind(i.center_lng).bind(i.radius_km).bind(i.priority).bind(i.is_active).bind(i.boundary.as_ref().map(sqlx::types::Json)).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM inventory.area_stock_links WHERE area_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for s in i.stocks {
            sqlx::query("INSERT INTO inventory.area_stock_links(area_id,stock_id,priority) VALUES($1,$2,$3)").bind(id).bind(s.stock_id).bind(s.priority).execute(&mut *tx).await?;
        }
        infra_events::record(
            &mut tx,
            "inventory.delivery_area_saved",
            json!({"id":id,"actor_id":actor}),
        )
        .await?;
        tx.commit().await?;
        Ok(id)
    }
}

/// Simple, non-degenerate polygons in longitude/latitude; edges and vertices count as inside.
pub fn validate_boundary(points: &[Pin]) -> Result<()> {
    if !(3..=100).contains(&points.len()) {
        return Err(invalid("Draw between 3 and 100 boundary points"));
    }
    for p in points {
        p.validate()?;
    }
    let min = points
        .iter()
        .map(|p| p.longitude)
        .fold(f64::INFINITY, f64::min);
    let max = points
        .iter()
        .map(|p| p.longitude)
        .fold(f64::NEG_INFINITY, f64::max);
    if max - min >= 180.0 {
        return Err(invalid("Boundary cannot cross the international date line"));
    }
    fn cross(a: Pin, b: Pin, c: Pin) -> f64 {
        (b.longitude - a.longitude) * (c.latitude - a.latitude)
            - (b.latitude - a.latitude) * (c.longitude - a.longitude)
    }
    fn on(a: Pin, b: Pin, p: Pin) -> bool {
        cross(a, b, p).abs() < 1e-12
            && p.longitude >= a.longitude.min(b.longitude)
            && p.longitude <= a.longitude.max(b.longitude)
            && p.latitude >= a.latitude.min(b.latitude)
            && p.latitude <= a.latitude.max(b.latitude)
    }
    let n = points.len();
    let mut area = 0.0;
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        area += cross(points[0], a, b);
        for j in (i + 1)..n {
            if (a.latitude - points[j].latitude).abs() < 1e-10
                && (a.longitude - points[j].longitude).abs() < 1e-10
            {
                return Err(invalid("Boundary points must be distinct"));
            }
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            let c = points[j];
            let d = points[(j + 1) % n];
            if (cross(a, b, c) * cross(a, b, d) < 0.0 && cross(c, d, a) * cross(c, d, b) < 0.0)
                || on(a, b, c)
                || on(a, b, d)
                || on(c, d, a)
                || on(c, d, b)
            {
                return Err(invalid("Boundary edges must not cross or touch each other"));
            }
        }
    }
    if area.abs() < 1e-10 {
        return Err(invalid("Boundary must enclose an area"));
    }
    Ok(())
}
