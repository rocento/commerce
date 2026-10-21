use super::*;
use domain_mobile::asset_library::{
    AssetFolder, AssetLibrary, LibraryQuery, MoveAssets, RenameAsset, SaveFolder,
};
pub(super) async fn library(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    Query(q): Query<LibraryQuery>,
    h: HeaderMap,
) -> ApiResult<Json<AssetLibrary>> {
    Ok(Json(
        a.service.asset_library(m, a.actor(&h).await?, q).await?,
    ))
}
pub(super) async fn folders(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    Query(_q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<AssetFolder>>> {
    Ok(Json(a.service.asset_folders(m, a.actor(&h).await?).await?))
}
pub(super) async fn create(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(input): Json<SaveFolder>,
) -> ApiResult<(StatusCode, Json<AssetFolder>)> {
    Ok((
        StatusCode::CREATED,
        Json(
            a.service
                .save_asset_folder(m, q.environment, a.actor(&h).await?, None, input)
                .await?,
        ),
    ))
}
pub(super) async fn save(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(input): Json<SaveFolder>,
) -> ApiResult<Json<AssetFolder>> {
    Ok(Json(
        a.service
            .save_asset_folder(m, q.environment, a.actor(&h).await?, Some(id), input)
            .await?,
    ))
}
pub(super) async fn delete(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    a.service
        .delete_asset_folder(m, q.environment, a.actor(&h).await?, id)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn move_assets(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(input): Json<MoveAssets>,
) -> ApiResult<Json<Value>> {
    a.service
        .move_assets(m, q.environment, a.actor(&h).await?, input)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn rename(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(input): Json<RenameAsset>,
) -> ApiResult<Json<Value>> {
    a.service
        .rename_asset(m, q.environment, a.actor(&h).await?, id, input)
        .await?;
    Ok(Json(json!({"ok":true})))
}
