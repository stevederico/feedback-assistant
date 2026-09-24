//! Feedback Assistant routes.
//!
//! Dashboard routes live under `/api` and require the caller's session.
//! Updates and deletes include that user id in the SQL predicate.
//! Widget ingest lives under `/v1` and authenticates with `X-Project-Key`.
//! Literal path segments are matched before parameterized ones.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::config;
use crate::crypto;
use crate::db::{self, Value};
use crate::http::{Request, Response};
use crate::json::{self, Json};
use crate::routes::{self, err_json, json_res, not_found};
use crate::state::AppState;

const MAX_MESSAGE_CHARS: usize = 5000;
const IP_CAPACITY: f64 = 60.0;
const IP_REFILL_PER_SEC: f64 = 1.0;
const WIDGET_CACHE_AUTO: &str = "public, max-age=300, must-revalidate";
const WIDGET_CACHE_PINNED: &str = "public, max-age=31536000, immutable";
const DEFAULT_SHOT_BYTES: usize = 2 * 1024 * 1024;

/// True for paths that must be embeddable on customer origins.
pub fn is_widget_surface(path: &str) -> bool {
    path == "/widget.js"
        || path.starts_with("/widget/")
        || path == "/v1"
        || path.starts_with("/v1/")
}

/// CORS preflight for the widget script and `/v1` ingest.
///
/// Credentials stay off. `Access-Control-Allow-Origin: *` is what a page on
/// an arbitrary customer origin needs in order to call the ingest API.
pub fn widget_preflight() -> Response {
    Response::empty(204)
        .set_header("Access-Control-Allow-Origin", "*")
        .set_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        .set_header("Access-Control-Allow-Headers", "Content-Type, X-Project-Key")
}

/// Force widget CORS (and CORP for script files) after security headers.
pub fn finish_widget_response(res: Response, path: &str) -> Response {
    let res = res.set_header("Access-Control-Allow-Origin", "*");
    if path == "/widget.js" || path.starts_with("/widget/") {
        res.set_header("Cross-Origin-Resource-Policy", "cross-origin")
    } else {
        res
    }
}

/// Parameterized feedback paths. Literal segments win over `:id`.
pub fn dispatch_param(state: &AppState, req: &Request) -> Option<Response> {
    if let Some(res) = apps_param(state, req) {
        return Some(res);
    }
    if let Some(res) = id_param(state, req, "/api/submissions/", submission_by_id) {
        return Some(res);
    }
    if let Some(res) = id_param(state, req, "/api/changelog/", changelog_by_id) {
        return Some(res);
    }
    if let Some(res) = id_param(state, req, "/api/screenshots/", screenshot_by_id) {
        return Some(res);
    }
    if let Some(res) = v1_project(state, req) {
        return Some(res);
    }
    versioned_widget(state, &req.path)
}

/// `GET /api/widget-integrity` — public SRI for the current widget bundle.
pub fn widget_integrity(state: &AppState) -> Response {
    let _ = state;
    json_res(
        200,
        &json::obj([
            ("version", json::s(app_version())),
            ("integrity", integrity_json()),
        ]),
    )
}

/// `GET /api/apps`
pub fn list_apps(state: &AppState, req: &Request) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    let rows = match state.pool.with(|db| {
        db.query(
            "SELECT id, name, public_key, allowed_origins, daily_budget, greeting, created_at
             FROM Apps WHERE org_id = (SELECT org_id FROM Users WHERE _id = ?)
             ORDER BY created_at DESC",
            &[Value::Text(user_id)],
        )
    }) {
        Ok(rows) => rows,
        Err(e) => return routes::db_err(state, "list apps", &e),
    };
    let apps: Vec<Json> = rows.iter().map(app_json_masked).collect();
    json_res(200, &json::obj([("apps", Json::Arr(apps))]))
}

/// `POST /api/apps`
pub fn create_app(state: &AppState, req: &Request) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    let org_id = match ensure_org(state, &user_id) {
        Ok(Some(id)) => id,
        Ok(None) => return err_json(400, "No org for user"),
        Err(res) => return res,
    };
    let body = match parse_obj(req) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let Some(name) = body.get_str("name").map(str::trim).filter(|s| !s.is_empty()) else {
        return err_json(400, "name required");
    };
    if name.chars().count() > 200 {
        return err_json(400, "name too long");
    }
    let allowed = body
        .get_str("allowedOrigins")
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let budget = budget_or(body.get("dailyBudget"), 1000);
    let greeting = greeting_value(body.get("greeting"));
    let id = match routes::generate_uuid() {
        Ok(id) => id,
        Err(res) => return res,
    };
    let public_key = match generate_public_key() {
        Ok(key) => key,
        Err(res) => return res,
    };
    let now = config::now_ms();
    if let Err(e) = state.pool.with(|db| {
        db.run(
            "INSERT INTO Apps (id, org_id, name, public_key, allowed_origins, daily_budget, greeting, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::Text(id.clone()),
                Value::Text(org_id.clone()),
                Value::Text(name.to_string()),
                Value::Text(public_key.clone()),
                Value::Text(allowed.clone()),
                Value::Int(budget),
                greeting.clone(),
                Value::Int(now),
            ],
        )?;
        Ok(())
    }) {
        return routes::db_err(state, "create app", &e);
    }
    state.log.info(
        "app created",
        &[("appId", json::s(id.clone())), ("orgId", json::s(org_id))],
    );
    json_res(
        201,
        &json::obj([
            ("id", json::s(id)),
            ("name", json::s(name)),
            ("publicKey", json::s(public_key)),
            ("allowedOrigins", json::s(allowed)),
            ("dailyBudget", json::i(budget)),
            ("greeting", value_to_json(&greeting)),
            ("createdAt", json::i(now)),
        ]),
    )
}

/// `GET /api/submissions` — org-wide inbox.
pub fn list_org_submissions(state: &AppState, req: &Request) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    let mut where_sql = vec!["p.org_id = (SELECT org_id FROM Users WHERE _id = ?)".to_string()];
    let mut params = vec![Value::Text(user_id)];
    if let Some(app_id) = req.query_param("appId").filter(|s| segment_ok(s)) {
        where_sql.push("s.app_id = ?".to_string());
        params.push(Value::Text(app_id));
    }
    list_submissions(state, req, &mut where_sql, &mut params)
}

/// `POST /v1/submissions`
pub fn ingest_submission(state: &AppState, req: &Request) -> Response {
    if let Err(retry) = allow_ip(&routes::client_ip(req)) {
        return rate_limited("rate limit exceeded", retry);
    }
    let key = req.header("x-project-key").unwrap_or("");
    let app_row = match find_app_by_key(state, key) {
        Ok(Some(row)) => row,
        Ok(None) => return err_json(401, "invalid or missing X-Project-Key"),
        Err(e) => return routes::db_err(state, "widget key lookup", &e),
    };
    if let Some(res) = reject_origin(state, req, &app_row) {
        return res;
    }
    if let Some(res) = enforce_budget(state, &app_row) {
        return res;
    }
    let Ok(body) = json::parse(&req.body) else {
        return err_json(400, "invalid json");
    };
    if body.as_obj().is_none() {
        return err_json(400, "invalid json");
    }
    let message = body.get_str("message").unwrap_or("").trim();
    if message.is_empty() {
        return err_json(400, "message required");
    }
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return err_json(400, &format!("message must be {MAX_MESSAGE_CHARS} characters or fewer"));
    }
    let screenshot_id = match body.get_str("screenshotId") {
        Some(id) if !id.is_empty() => match screenshot_owned_by_app(state, id, &app_row.id) {
            Ok(true) => Some(id.to_string()),
            Ok(false) => return err_json(400, "screenshotId not found for this app"),
            Err(e) => return routes::db_err(state, "screenshot lookup", &e),
        },
        _ => None,
    };
    let id = match routes::generate_uuid() {
        Ok(id) => id,
        Err(res) => return res,
    };
    let now = config::now_ms();
    if let Err(e) = state.pool.with(|db| {
        db.run(
            "INSERT INTO Submissions (
                id, app_id, message, url, user_agent, app_version,
                end_user_id, end_user_name, end_user_email, screenshot_id, status, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)",
            &[
                Value::Text(id.clone()),
                Value::Text(app_row.id.clone()),
                Value::Text(message.to_string()),
                opt_text(truncate_field(body.get("url"), 2000)),
                opt_text(truncate_field(body.get("userAgent"), 500)),
                opt_text(truncate_field(body.get("appVersion"), 64)),
                opt_text(truncate_field(body.get("endUserId"), 200)),
                opt_text(truncate_field(body.get("endUserName"), 200)),
                opt_text(truncate_field(body.get("endUserEmail"), 320)),
                opt_text(screenshot_id.clone()),
                Value::Int(now),
            ],
        )?;
        Ok(())
    }) {
        return routes::db_err(state, "insert submission", &e);
    }
    state.log.info(
        "submission persisted",
        &[
            ("submissionId", json::s(id.clone())),
            ("appId", json::s(app_row.id)),
        ],
    );
    json_res(
        200,
        &json::obj([("ok", Json::Bool(true)), ("submissionId", json::s(id))]),
    )
}

/// `POST /v1/screenshots`
pub fn ingest_screenshot(state: &AppState, req: &Request) -> Response {
    if let Err(retry) = allow_ip(&routes::client_ip(req)) {
        return rate_limited("rate limit exceeded", retry);
    }
    let key = req.header("x-project-key").unwrap_or("");
    let app_row = match find_app_by_key(state, key) {
        Ok(Some(row)) => row,
        Ok(None) => return err_json(401, "invalid or missing X-Project-Key"),
        Err(e) => return routes::db_err(state, "widget key lookup", &e),
    };
    if let Some(res) = reject_origin(state, req, &app_row) {
        return res;
    }
    let content_type = req.header("content-type").unwrap_or("");
    let (mime, bytes) = match parse_file_part(content_type, &req.body) {
        Ok(part) => part,
        Err(MultipartError::Invalid) => return err_json(400, "invalid multipart body"),
        Err(MultipartError::MissingFile) => return err_json(400, "file field required"),
    };
    if !is_allowed_mime(&mime) {
        return err_json(415, "only image/jpeg or image/png allowed");
    }
    let max = max_screenshot_bytes();
    if bytes.len() > max {
        return err_json(413, &format!("file too large (max {max} bytes)"));
    }
    let stored_id = match save_screenshot(&uploads_dir(state), &bytes) {
        Ok(id) => id,
        Err(e) => {
            state.log.error(
                "screenshot write failed",
                &[("error", json::s(e.to_string()))],
            );
            return err_json(500, "storage error");
        }
    };
    let now = config::now_ms();
    if let Err(e) = state.pool.with(|db| {
        db.run(
            "INSERT INTO Screenshots (id, app_id, content_type, size_bytes, created_at)
             VALUES (?, ?, ?, ?, ?)",
            &[
                Value::Text(stored_id.clone()),
                Value::Text(app_row.id.clone()),
                Value::Text(mime.clone()),
                Value::Int(bytes.len() as i64),
                Value::Int(now),
            ],
        )?;
        Ok(())
    }) {
        let _ = std::fs::remove_file(uploads_dir(state).join(&stored_id));
        return routes::db_err(state, "insert screenshot", &e);
    }
    json_res(200, &json::obj([("screenshotId", json::s(stored_id))]))
}

/// `GET /widget.js`
pub fn widget_script_auto(state: &AppState) -> Response {
    let _ = state;
    serve_js(&bundle_path(), WIDGET_CACHE_AUTO)
}

/// `GET /widget/html2canvas-v1.js`
pub fn widget_html2canvas(state: &AppState) -> Response {
    let _ = state;
    serve_js(&html2canvas_path(), WIDGET_CACHE_PINNED)
}

fn apps_param(state: &AppState, req: &Request) -> Option<Response> {
    let rest = req.path.strip_prefix("/api/apps/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.iter().any(|part| !segment_ok(part)) {
        return Some(not_found());
    }
    Some(match (req.method.as_str(), parts.as_slice()) {
        ("POST", [id, "changelog", "reorder"]) => reorder_changelog(state, req, id),
        ("POST", [id, "rotate-key"]) => rotate_key(state, req, id),
        ("GET" | "HEAD", [id, "submissions"]) => list_app_submissions(state, req, id),
        ("GET" | "HEAD", [id, "changelog"]) => list_changelog(state, req, id),
        ("POST", [id, "changelog"]) => create_changelog(state, req, id),
        ("PATCH", [id]) => patch_app(state, req, id),
        ("DELETE", [id]) => delete_app(state, req, id),
        _ => not_found(),
    })
}

fn id_param(
    state: &AppState,
    req: &Request,
    prefix: &str,
    handler: fn(&AppState, &Request, &str) -> Response,
) -> Option<Response> {
    let rest = req.path.strip_prefix(prefix)?;
    if rest.contains('/') || !segment_ok(rest) {
        return Some(not_found());
    }
    Some(handler(state, req, rest))
}

fn submission_by_id(state: &AppState, req: &Request, id: &str) -> Response {
    match req.method.as_str() {
        "GET" | "HEAD" => get_submission(state, req, id),
        "PATCH" => patch_submission(state, req, id),
        "DELETE" => delete_submission(state, req, id),
        _ => not_found(),
    }
}

fn changelog_by_id(state: &AppState, req: &Request, id: &str) -> Response {
    match req.method.as_str() {
        "PATCH" => patch_changelog(state, req, id),
        "DELETE" => delete_changelog(state, req, id),
        _ => not_found(),
    }
}

fn screenshot_by_id(state: &AppState, req: &Request, id: &str) -> Response {
    if req.method != "GET" && req.method != "HEAD" {
        return not_found();
    }
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    let row = match state.pool.with(|db| {
        db.query(
            "SELECT s.id, s.content_type, s.size_bytes
             FROM Screenshots s
             JOIN Apps p ON p.id = s.app_id
             WHERE s.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)",
            &[Value::Text(id.to_string()), Value::Text(user_id)],
        )
    }) {
        Ok(rows) => rows.into_iter().next(),
        Err(e) => return routes::db_err(state, "screenshot lookup", &e),
    };
    let Some(row) = row else {
        return err_json(403, "Forbidden");
    };
    let Some(content_type) = row.text("content_type") else {
        return err_json(500, "Server error");
    };
    if content_type.bytes().any(|b| b == b'\r' || b == b'\n') {
        return err_json(500, "Server error");
    }
    let path = uploads_dir(state).join(id);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return err_json(404, "File missing"),
    };
    Response::bytes(200, content_type, bytes)
        .set_header("Content-Disposition", "inline")
        .set_header("Cache-Control", "private, no-store")
        .set_header("X-Content-Type-Options", "nosniff")
}

fn v1_project(state: &AppState, req: &Request) -> Option<Response> {
    let rest = req.path.strip_prefix("/v1/projects/")?;
    let mut parts = rest.split('/');
    let pk = parts.next().unwrap_or("");
    let tail = parts.next();
    if parts.next().is_some() || !segment_ok(pk) {
        return Some(not_found());
    }
    Some(match (req.method.as_str(), tail) {
        ("GET" | "HEAD", Some("widget")) => widget_config(state, req, pk),
        ("GET" | "HEAD", Some("changelog")) => widget_changelog(state, req, pk),
        _ => not_found(),
    })
}

fn versioned_widget(state: &AppState, path: &str) -> Option<Response> {
    let _ = state;
    let rest = path.strip_prefix("/widget/v")?;
    let ver = rest.strip_suffix(".js")?;
    if ver.is_empty() || ver.contains('/') {
        return Some(not_found());
    }
    if ver == app_version() {
        Some(serve_js(&bundle_path(), WIDGET_CACHE_PINNED))
    } else {
        Some(Response::text(404, "Widget asset missing"))
    }
}

fn patch_app(state: &AppState, req: &Request, app_id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    if !app_owned(state, app_id, &user_id) {
        return err_json(404, "Not found");
    }
    let body = match parse_obj(req) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(name) = body.get_str("name") {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 200 {
            return err_json(400, "invalid name");
        }
        sets.push("name = ?");
        params.push(Value::Text(name.to_string()));
    }
    if let Some(origins) = body.get_str("allowedOrigins") {
        sets.push("allowed_origins = ?");
        params.push(Value::Text(origins.trim().to_string()));
    }
    if let Some(budget) = body.get("dailyBudget").and_then(json_budget) {
        sets.push("daily_budget = ?");
        params.push(Value::Int(budget));
    }
    if let Some(greeting) = greeting_update(body.get("greeting")) {
        sets.push("greeting = ?");
        params.push(greeting);
    }
    if sets.is_empty() {
        return err_json(400, "nothing to update");
    }
    params.push(Value::Text(app_id.to_string()));
    params.push(Value::Text(user_id.clone()));
    let sql = format!(
        "UPDATE Apps SET {} WHERE id = ? AND org_id = (SELECT org_id FROM Users WHERE _id = ?)",
        sets.join(", ")
    );
    match write_changes(state, &sql, &params) {
        Ok(0) => return err_json(404, "Not found"),
        Ok(_) => {}
        Err(e) => return routes::db_err(state, "patch app", &e),
    }
    match load_app(state, app_id, &user_id) {
        Ok(Some(row)) => json_res(200, &app_json_masked(&row)),
        Ok(None) => err_json(404, "Not found"),
        Err(e) => routes::db_err(state, "reload app", &e),
    }
}

fn delete_app(state: &AppState, req: &Request, app_id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    let deleted = state.pool.transaction(|db| {
        let owned = db.query(
            "SELECT id FROM Apps WHERE id = ? AND org_id = (SELECT org_id FROM Users WHERE _id = ?)",
            &[Value::Text(app_id.to_string()), Value::Text(user_id.clone())],
        )?;
        if owned.is_empty() {
            return Ok(None);
        }
        let shots = db.query(
            "SELECT id FROM Screenshots WHERE app_id = ?",
            &[Value::Text(app_id.to_string())],
        )?;
        let ids: Vec<String> = shots.iter().filter_map(|row| row.text("id").map(str::to_string)).collect();
        let scope = [
            Value::Text(app_id.to_string()),
            Value::Text(user_id.clone()),
        ];
        for table in ["Submissions", "Screenshots", "Changelog", "DailyIngest"] {
            db.run(
                &format!(
                    "DELETE FROM {table} WHERE app_id IN (
                        SELECT id FROM Apps WHERE id = ? AND org_id = (SELECT org_id FROM Users WHERE _id = ?)
                    )"
                ),
                &scope,
            )?;
        }
        db.run(
            "DELETE FROM Apps WHERE id = ? AND org_id = (SELECT org_id FROM Users WHERE _id = ?)",
            &scope,
        )?;
        Ok(Some(ids))
    });
    match deleted {
        Ok(None) => err_json(404, "Not found"),
        Ok(Some(ids)) => {
            for id in ids {
                delete_screenshot_file(state, &id);
            }
            json_res(200, &json::obj([("ok", Json::Bool(true))]))
        }
        Err(e) => routes::db_err(state, "delete app", &e),
    }
}

fn rotate_key(state: &AppState, req: &Request, app_id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    let new_key = match generate_public_key() {
        Ok(key) => key,
        Err(res) => return res,
    };
    match write_changes(
        state,
        "UPDATE Apps SET public_key = ? WHERE id = ? AND org_id = (SELECT org_id FROM Users WHERE _id = ?)",
        &[
            Value::Text(new_key.clone()),
            Value::Text(app_id.to_string()),
            Value::Text(user_id),
        ],
    ) {
        Ok(0) => err_json(404, "Not found"),
        Ok(_) => json_res(
            200,
            &json::obj([("id", json::s(app_id)), ("publicKey", json::s(new_key))]),
        ),
        Err(e) => routes::db_err(state, "rotate key", &e),
    }
}

fn list_app_submissions(state: &AppState, req: &Request, app_id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    if !app_owned(state, app_id, &user_id) {
        return err_json(404, "Not found");
    }
    let mut where_sql = vec!["s.app_id = ?".to_string()];
    let mut params = vec![Value::Text(app_id.to_string())];
    list_submissions(state, req, &mut where_sql, &mut params)
}

fn get_submission(state: &AppState, req: &Request, id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    match ensure_org(state, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(403, "Forbidden"),
        Err(res) => return res,
    }
    let rows = match state.pool.with(|db| {
        db.query(
            "SELECT s.*, p.name AS app_name
             FROM Submissions s
             JOIN Apps p ON p.id = s.app_id
             WHERE s.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)",
            &[Value::Text(id.to_string()), Value::Text(user_id)],
        )
    }) {
        Ok(rows) => rows,
        Err(e) => return routes::db_err(state, "get submission", &e),
    };
    let Some(row) = rows.first() else {
        return err_json(404, "Not found");
    };
    json_res(200, &submission_detail(row))
}

fn patch_submission(state: &AppState, req: &Request, id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    match ensure_org(state, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(403, "Forbidden"),
        Err(res) => return res,
    }
    let body = match parse_obj(req) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let Some(status) = body.get_str("status") else {
        return err_json(400, "status must be new | read | archived");
    };
    if !matches!(status, "new" | "read" | "archived") {
        return err_json(400, "status must be new | read | archived");
    }
    let sql = "UPDATE Submissions SET status = ? WHERE id = ? AND id IN (
        SELECT s.id FROM Submissions s
        JOIN Apps p ON p.id = s.app_id
        WHERE s.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)
    )";
    match write_changes(
        state,
        sql,
        &[
            Value::Text(status.to_string()),
            Value::Text(id.to_string()),
            Value::Text(id.to_string()),
            Value::Text(user_id),
        ],
    ) {
        Ok(0) => err_json(404, "Not found"),
        Ok(_) => json_res(
            200,
            &json::obj([("id", json::s(id)), ("status", json::s(status))]),
        ),
        Err(e) => routes::db_err(state, "patch submission", &e),
    }
}

fn delete_submission(state: &AppState, req: &Request, id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    match ensure_org(state, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(403, "Forbidden"),
        Err(res) => return res,
    }
    let removed = state.pool.transaction(|db| {
        let rows = db.query(
            "SELECT s.screenshot_id FROM Submissions s
             JOIN Apps p ON p.id = s.app_id
             WHERE s.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)",
            &[Value::Text(id.to_string()), Value::Text(user_id.clone())],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let shot = match row.get("screenshot_id") {
            Some(Value::Text(value)) if !value.is_empty() => Some(value.clone()),
            _ => None,
        };
        let mut file_id = None;
        if let Some(ref shot_id) = shot {
            let others = db.query(
                "SELECT COUNT(*) AS n FROM Submissions WHERE screenshot_id = ? AND id != ?",
                &[Value::Text(shot_id.clone()), Value::Text(id.to_string())],
            )?;
            let n = others.first().and_then(|r| r.int("n")).unwrap_or(0);
            if n == 0 {
                file_id = Some(shot_id.clone());
            }
        }
        db.run(
            "DELETE FROM Submissions WHERE id = ? AND id IN (
                SELECT s.id FROM Submissions s
                JOIN Apps p ON p.id = s.app_id
                WHERE s.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)
            )",
            &[
                Value::Text(id.to_string()),
                Value::Text(id.to_string()),
                Value::Text(user_id.clone()),
            ],
        )?;
        if let Some(ref shot_id) = file_id {
            db.run(
                "DELETE FROM Screenshots WHERE id = ? AND app_id IN (
                    SELECT id FROM Apps WHERE org_id = (SELECT org_id FROM Users WHERE _id = ?)
                )",
                &[Value::Text(shot_id.clone()), Value::Text(user_id.clone())],
            )?;
        }
        Ok(Some(file_id))
    });
    match removed {
        Ok(None) => err_json(404, "Not found"),
        Ok(Some(file_id)) => {
            if let Some(shot_id) = file_id {
                delete_screenshot_file(state, &shot_id);
            }
            json_res(200, &json::obj([("ok", Json::Bool(true))]))
        }
        Err(e) => routes::db_err(state, "delete submission", &e),
    }
}

fn list_changelog(state: &AppState, req: &Request, app_id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    if let Err(res) = ensure_org(state, &user_id) {
        return res;
    }
    if !app_owned(state, app_id, &user_id) {
        return err_json(404, "Not found");
    }
    let rows = match state.pool.with(|db| {
        db.query(
            "SELECT id, title, body_md, sort_order, published_at, created_at
             FROM Changelog WHERE app_id = ? ORDER BY sort_order ASC",
            &[Value::Text(app_id.to_string())],
        )
    }) {
        Ok(rows) => rows,
        Err(e) => return routes::db_err(state, "list changelog", &e),
    };
    let items: Vec<Json> = rows.iter().map(changelog_json).collect();
    json_res(200, &json::obj([("changelog", Json::Arr(items))]))
}

fn create_changelog(state: &AppState, req: &Request, app_id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    match ensure_org(state, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(403, "Forbidden"),
        Err(res) => return res,
    }
    if !app_owned(state, app_id, &user_id) {
        return err_json(404, "Not found");
    }
    let body = match parse_obj(req) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let Some(title) = body.get_str("title").map(str::trim).filter(|s| !s.is_empty()) else {
        return err_json(400, "title required");
    };
    if title.chars().count() > 200 {
        return err_json(400, "title too long");
    }
    let body_md = truncate_chars(body.get_str("body").unwrap_or(""), 50_000);
    let publish = body.get("publish").and_then(Json::as_bool) == Some(true);
    let id = match routes::generate_uuid() {
        Ok(id) => id,
        Err(res) => return res,
    };
    let now = config::now_ms();
    let inserted = state.pool.transaction(|db| {
        let max_row = db.query(
            "SELECT MAX(sort_order) AS m FROM Changelog WHERE app_id = ?",
            &[Value::Text(app_id.to_string())],
        )?;
        let sort_order = max_row.first().and_then(|row| row.int("m")).unwrap_or(0) + 1;
        let published = if publish { Value::Int(now) } else { Value::Null };
        db.run(
            "INSERT INTO Changelog (id, app_id, title, body_md, sort_order, published_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::Text(id.clone()),
                Value::Text(app_id.to_string()),
                Value::Text(title.to_string()),
                Value::Text(body_md.clone()),
                Value::Int(sort_order),
                published,
                Value::Int(now),
            ],
        )?;
        Ok(sort_order)
    });
    match inserted {
        Ok(sort_order) => json_res(
            201,
            &json::obj([
                ("id", json::s(id)),
                ("title", json::s(title)),
                ("body", json::s(body_md)),
                ("sortOrder", json::i(sort_order)),
                (
                    "publishedAt",
                    if publish { json::i(now) } else { Json::Null },
                ),
                ("createdAt", json::i(now)),
            ]),
        ),
        Err(e) => routes::db_err(state, "create changelog", &e),
    }
}

fn patch_changelog(state: &AppState, req: &Request, id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    match ensure_org(state, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(403, "Forbidden"),
        Err(res) => return res,
    }
    let owned = match state.pool.with(|db| {
        db.query(
            "SELECT cl.published_at FROM Changelog cl
             JOIN Apps p ON p.id = cl.app_id
             WHERE cl.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)",
            &[Value::Text(id.to_string()), Value::Text(user_id.clone())],
        )
    }) {
        Ok(rows) => rows.into_iter().next(),
        Err(e) => return routes::db_err(state, "changelog lookup", &e),
    };
    let Some(owned) = owned else {
        return err_json(404, "Not found");
    };
    let body = match parse_obj(req) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(title) = body.get_str("title") {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return err_json(400, "invalid title");
        }
        sets.push("title = ?");
        params.push(Value::Text(title.to_string()));
    }
    if let Some(text) = body.get_str("body") {
        sets.push("body_md = ?");
        params.push(Value::Text(truncate_chars(text, 50_000)));
    }
    if let Some(publish) = body.get("publish").and_then(Json::as_bool) {
        let published = if publish {
            Value::Int(owned.int("published_at").unwrap_or_else(config::now_ms))
        } else {
            Value::Null
        };
        sets.push("published_at = ?");
        params.push(published);
    }
    if sets.is_empty() {
        return err_json(400, "nothing to update");
    }
    params.push(Value::Text(id.to_string()));
    params.push(Value::Text(user_id));
    let sql = format!(
        "UPDATE Changelog SET {} WHERE id = ? AND id IN (
            SELECT cl.id FROM Changelog cl
            JOIN Apps p ON p.id = cl.app_id
            WHERE cl.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)
        )",
        sets.join(", ")
    );
    // The WHERE repeats the id, so the user id is the last bound value and the
    // id is bound twice. Rebuild params to match that shape.
    let user = params.pop().unwrap_or(Value::Null);
    let entry_id = params.pop().unwrap_or(Value::Null);
    params.push(entry_id.clone());
    params.push(entry_id);
    params.push(user);
    match write_changes(state, &sql, &params) {
        Ok(0) => return err_json(404, "Not found"),
        Ok(_) => {}
        Err(e) => return routes::db_err(state, "patch changelog", &e),
    }
    let rows = match state.pool.with(|db| {
        db.query(
            "SELECT id, title, body_md, sort_order, published_at, created_at FROM Changelog WHERE id = ?",
            &[Value::Text(id.to_string())],
        )
    }) {
        Ok(rows) => rows,
        Err(e) => return routes::db_err(state, "reload changelog", &e),
    };
    let Some(row) = rows.first() else {
        return err_json(404, "Not found");
    };
    json_res(200, &changelog_json(row))
}

fn delete_changelog(state: &AppState, req: &Request, id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    match ensure_org(state, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(403, "Forbidden"),
        Err(res) => return res,
    }
    match write_changes(
        state,
        "DELETE FROM Changelog WHERE id = ? AND id IN (
            SELECT cl.id FROM Changelog cl
            JOIN Apps p ON p.id = cl.app_id
            WHERE cl.id = ? AND p.org_id = (SELECT org_id FROM Users WHERE _id = ?)
        )",
        &[
            Value::Text(id.to_string()),
            Value::Text(id.to_string()),
            Value::Text(user_id),
        ],
    ) {
        Ok(0) => err_json(404, "Not found"),
        Ok(_) => json_res(200, &json::obj([("ok", Json::Bool(true))])),
        Err(e) => routes::db_err(state, "delete changelog", &e),
    }
}

fn reorder_changelog(state: &AppState, req: &Request, app_id: &str) -> Response {
    let user_id = match gate(state, req) {
        Ok(id) => id,
        Err(res) => return res,
    };
    match ensure_org(state, &user_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(403, "Forbidden"),
        Err(res) => return res,
    }
    if !app_owned(state, app_id, &user_id) {
        return err_json(404, "Not found");
    }
    let Ok(body) = json::parse(&req.body) else {
        return err_json(400, "Invalid JSON");
    };
    let Some(items) = body.get("items").and_then(Json::as_arr) else {
        return err_json(400, "items array required");
    };
    let result = state.pool.transaction(|db| {
        for item in items {
            let Some(obj) = item.as_obj() else { continue };
            let Some(item_id) = obj.get("id").and_then(Json::as_str) else {
                continue;
            };
            let Some(sort_order) = obj.get("sortOrder").and_then(Json::as_i64) else {
                continue;
            };
            db.run(
                "UPDATE Changelog SET sort_order = ? WHERE id = ? AND app_id = ? AND app_id IN (
                    SELECT id FROM Apps WHERE id = ? AND org_id = (SELECT org_id FROM Users WHERE _id = ?)
                )",
                &[
                    Value::Int(sort_order),
                    Value::Text(item_id.to_string()),
                    Value::Text(app_id.to_string()),
                    Value::Text(app_id.to_string()),
                    Value::Text(user_id.clone()),
                ],
            )?;
        }
        Ok(())
    });
    match result {
        Ok(()) => json_res(200, &json::obj([("ok", Json::Bool(true))])),
        Err(e) => routes::db_err(state, "reorder changelog", &e),
    }
}

fn widget_config(state: &AppState, req: &Request, pk: &str) -> Response {
    let app_row = match find_app_by_key(state, pk) {
        Ok(row) => row,
        Err(e) => return routes::db_err(state, "widget config", &e),
    };
    let Some(app_row) = app_row else {
        return json_res(200, &json::obj([("greeting", Json::Null)]))
            .set_header("Cache-Control", "public, max-age=60");
    };
    if let Some(res) = reject_origin(state, req, &app_row) {
        return res.set_header("Cache-Control", "public, max-age=60");
    }
    json_res(
        200,
        &json::obj([("greeting", opt_json(app_row.greeting.as_deref()))]),
    )
    .set_header("Cache-Control", "public, max-age=60")
}

fn widget_changelog(state: &AppState, req: &Request, pk: &str) -> Response {
    let app_row = match find_app_by_key(state, pk) {
        Ok(row) => row,
        Err(e) => return routes::db_err(state, "widget changelog", &e),
    };
    let Some(app_row) = app_row else {
        return json_res(200, &json::obj([("changelog", Json::Arr(Vec::new()))]));
    };
    if let Some(res) = reject_origin(state, req, &app_row) {
        return res;
    }
    let rows = match state.pool.with(|db| {
        db.query(
            "SELECT id, title, body_md, published_at FROM Changelog
             WHERE app_id = ? AND published_at IS NOT NULL
             ORDER BY sort_order ASC",
            &[Value::Text(app_row.id)],
        )
    }) {
        Ok(rows) => rows,
        Err(e) => return routes::db_err(state, "public changelog", &e),
    };
    let items: Vec<Json> = rows
        .iter()
        .map(|row| {
            json::obj([
                ("id", json::s(row.text("id").unwrap_or(""))),
                ("title", json::s(row.text("title").unwrap_or(""))),
                ("body", json::s(row.text("body_md").unwrap_or(""))),
                ("publishedAt", json::i(row.int("published_at").unwrap_or(0))),
            ])
        })
        .collect();
    json_res(200, &json::obj([("changelog", Json::Arr(items))]))
}

struct AppKey {
    id: String,
    daily_budget: i64,
    greeting: Option<String>,
    allowed_origins: String,
}

fn find_app_by_key(state: &AppState, public_key: &str) -> Result<Option<AppKey>, db::DbError> {
    if !public_key.starts_with("pk_") {
        return Ok(None);
    }
    state.pool.with(|db| {
        let rows = db.query(
            "SELECT id, daily_budget, greeting, allowed_origins FROM Apps WHERE public_key = ?",
            &[Value::Text(public_key.to_string())],
        )?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(AppKey {
            id: row.text("id").unwrap_or("").to_string(),
            daily_budget: row.int("daily_budget").unwrap_or(1000),
            greeting: row.text("greeting").map(str::to_string),
            allowed_origins: row.text("allowed_origins").unwrap_or("").to_string(),
        }))
    })
}

fn reject_origin(state: &AppState, req: &Request, app_row: &AppKey) -> Option<Response> {
    let allowed = parse_allowed_origins(&app_row.allowed_origins);
    if origin_allowed(req.header("origin"), allowed.as_deref()) {
        return None;
    }
    state.log.warn(
        "widget origin rejected",
        &[
            ("appId", json::s(app_row.id.clone())),
            ("origin", json::s(req.header("origin").unwrap_or(""))),
        ],
    );
    Some(err_json(403, "origin not allowed"))
}

fn enforce_budget(state: &AppState, app_row: &AppKey) -> Option<Response> {
    let day = utc_day_key(config::now_ms());
    let count = match state.pool.with(|db| {
        db.query(
            "INSERT INTO DailyIngest (app_id, day_utc, count) VALUES (?, ?, 1)
             ON CONFLICT(app_id, day_utc) DO UPDATE SET count = count + 1
             RETURNING count",
            &[Value::Text(app_row.id.clone()), Value::Text(day)],
        )
    }) {
        Ok(rows) => rows.first().and_then(|row| row.int("count")).unwrap_or(1),
        Err(e) => return Some(routes::db_err(state, "daily budget", &e)),
    };
    if count > app_row.daily_budget {
        let retry = seconds_until_utc_midnight(config::now_ms()).max(60);
        return Some(rate_limited("daily budget exceeded", retry));
    }
    None
}

fn list_submissions(
    state: &AppState,
    req: &Request,
    where_sql: &mut Vec<String>,
    params: &mut Vec<Value>,
) -> Response {
    let (limit, offset) = extend_filters(req, where_sql, params);
    let where_clause = where_sql.join(" AND ");
    let list_sql = format!(
        "SELECT s.id, s.app_id, p.name AS app_name, s.message, s.url,
                s.end_user_name, s.end_user_email, s.screenshot_id, s.status, s.created_at
         FROM Submissions s
         JOIN Apps p ON p.id = s.app_id
         WHERE {where_clause}
         ORDER BY s.created_at DESC
         LIMIT ? OFFSET ?"
    );
    let mut list_params = params.clone();
    list_params.push(Value::Int(limit));
    list_params.push(Value::Int(offset));
    let rows = match state.pool.with(|db| db.query(&list_sql, &list_params)) {
        Ok(rows) => rows,
        Err(e) => return routes::db_err(state, "list submissions", &e),
    };
    let total = match state.pool.with(|db| {
        db.query(
            &format!(
                "SELECT COUNT(*) AS n FROM Submissions s JOIN Apps p ON p.id = s.app_id WHERE {where_clause}"
            ),
            params,
        )
    }) {
        Ok(rows) => rows.first().and_then(|row| row.int("n")).unwrap_or(0),
        Err(e) => return routes::db_err(state, "count submissions", &e),
    };
    let items: Vec<Json> = rows.iter().map(submission_list_json).collect();
    json_res(
        200,
        &json::obj([
            ("submissions", Json::Arr(items)),
            ("total", json::i(total)),
            ("limit", json::i(limit)),
            ("offset", json::i(offset)),
        ]),
    )
}

fn extend_filters(req: &Request, where_sql: &mut Vec<String>, params: &mut Vec<Value>) -> (i64, i64) {
    if let Some(status) = req.query_param("status") {
        if matches!(status.as_str(), "new" | "read" | "archived") {
            where_sql.push("s.status = ?".to_string());
            params.push(Value::Text(status));
        }
    }
    if let Some(q) = req.query_param("q") {
        let q = q.trim();
        if !q.is_empty() {
            where_sql.push(
                "(s.message LIKE ? OR s.end_user_name LIKE ? OR s.end_user_email LIKE ? OR s.url LIKE ?)"
                    .to_string(),
            );
            let like = Value::Text(format!("%{q}%"));
            params.push(like.clone());
            params.push(like.clone());
            params.push(like.clone());
            params.push(like);
        }
    }
    if let Some(from) = req.query_param("from").filter(|v| digits(v)) {
        if let Ok(ms) = from.parse::<i64>() {
            where_sql.push("s.created_at >= ?".to_string());
            params.push(Value::Int(ms));
        }
    }
    if let Some(to) = req.query_param("to").filter(|v| digits(v)) {
        if let Ok(ms) = to.parse::<i64>() {
            where_sql.push("s.created_at <= ?".to_string());
            params.push(Value::Int(ms));
        }
    }
    let limit = req
        .query_param("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|n| n.clamp(1, 200))
        .unwrap_or(50);
    let offset = req
        .query_param("offset")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|n| n.max(0))
        .unwrap_or(0);
    (limit, offset)
}

/// Session plus CSRF. GET skips the CSRF check inside `require_csrf`.
fn gate(state: &AppState, req: &Request) -> Result<String, Response> {
    let user_id = routes::require_auth(state, req)?;
    routes::require_csrf(state, req, &user_id)?;
    Ok(user_id)
}

/// Backfill an org for accounts created before orgs existed.
///
/// `Ok(None)` means the user row is gone. `Err` is an HTTP response.
fn ensure_org(state: &AppState, user_id: &str) -> Result<Option<String>, Response> {
    let new_org = routes::generate_uuid()?;
    let now = config::now_ms();
    let result = state.pool.transaction(|db| {
        let rows = db.query(
            "SELECT org_id, name, email FROM Users WHERE _id = ?",
            &[Value::Text(user_id.to_string())],
        )?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        if let Some(org_id) = row.text("org_id").filter(|id| !id.is_empty()) {
            return Ok(Some(org_id.to_string()));
        }
        let label = row
            .text("name")
            .filter(|s| !s.is_empty())
            .or_else(|| row.text("email").filter(|s| !s.is_empty()))
            .unwrap_or("My");
        let org_name = format!("{label}'s workspace");
        db.run(
            "INSERT INTO Orgs (id, name, created_at) VALUES (?, ?, ?)",
            &[
                Value::Text(new_org.clone()),
                Value::Text(org_name),
                Value::Int(now),
            ],
        )?;
        db.run(
            "UPDATE Users SET org_id = ? WHERE _id = ?",
            &[Value::Text(new_org.clone()), Value::Text(user_id.to_string())],
        )?;
        Ok(Some(new_org))
    });
    result.map_err(|e| routes::db_err(state, "ensure org", &e))
}

fn app_owned(state: &AppState, app_id: &str, user_id: &str) -> bool {
    matches!(load_app(state, app_id, user_id), Ok(Some(_)))
}

fn load_app(
    state: &AppState,
    app_id: &str,
    user_id: &str,
) -> Result<Option<db::Row>, db::DbError> {
    state.pool.with(|db| {
        let rows = db.query(
            "SELECT id, name, public_key, allowed_origins, daily_budget, greeting, created_at
             FROM Apps WHERE id = ? AND org_id = (SELECT org_id FROM Users WHERE _id = ?)",
            &[Value::Text(app_id.to_string()), Value::Text(user_id.to_string())],
        )?;
        Ok(rows.into_iter().next())
    })
}

fn screenshot_owned_by_app(
    state: &AppState,
    screenshot_id: &str,
    app_id: &str,
) -> Result<bool, db::DbError> {
    state.pool.with(|db| {
        let rows = db.query(
            "SELECT id FROM Screenshots WHERE id = ? AND app_id = ?",
            &[
                Value::Text(screenshot_id.to_string()),
                Value::Text(app_id.to_string()),
            ],
        )?;
        Ok(!rows.is_empty())
    })
}

fn write_changes(state: &AppState, sql: &str, params: &[Value]) -> Result<i64, db::DbError> {
    state
        .pool
        .with(|db| db.run(sql, params).map(|changes| changes.changes))
}

fn parse_obj(req: &Request) -> Result<Json, Response> {
    match json::parse(&req.body) {
        Ok(value) if value.as_obj().is_some() => Ok(value),
        _ => Err(err_json(400, "Invalid JSON")),
    }
}

fn generate_public_key() -> Result<String, Response> {
    let bytes = crypto::random_bytes(16).map_err(|_| err_json(500, "Server error"))?;
    Ok(format!("pk_{}", crypto::hex_encode(&bytes)))
}

fn app_json_masked(row: &db::Row) -> Json {
    json::obj([
        ("id", json::s(row.text("id").unwrap_or(""))),
        ("name", json::s(row.text("name").unwrap_or(""))),
        (
            "publicKey",
            opt_json(row.text("public_key").map(mask_key).as_deref()),
        ),
        ("allowedOrigins", null_text(row, "allowed_origins")),
        ("dailyBudget", json::i(row.int("daily_budget").unwrap_or(1000))),
        ("greeting", null_text(row, "greeting")),
        ("createdAt", json::i(row.int("created_at").unwrap_or(0))),
    ])
}

fn submission_list_json(row: &db::Row) -> Json {
    json::obj([
        ("id", json::s(row.text("id").unwrap_or(""))),
        ("appId", json::s(row.text("app_id").unwrap_or(""))),
        ("appName", json::s(row.text("app_name").unwrap_or(""))),
        ("message", json::s(row.text("message").unwrap_or(""))),
        ("url", null_text(row, "url")),
        ("endUserName", null_text(row, "end_user_name")),
        ("endUserEmail", null_text(row, "end_user_email")),
        ("screenshotId", null_text(row, "screenshot_id")),
        ("status", json::s(row.text("status").unwrap_or(""))),
        ("createdAt", json::i(row.int("created_at").unwrap_or(0))),
    ])
}

fn submission_detail(row: &db::Row) -> Json {
    json::obj([
        ("id", json::s(row.text("id").unwrap_or(""))),
        ("appId", json::s(row.text("app_id").unwrap_or(""))),
        ("appName", json::s(row.text("app_name").unwrap_or(""))),
        ("message", json::s(row.text("message").unwrap_or(""))),
        ("url", null_text(row, "url")),
        ("userAgent", null_text(row, "user_agent")),
        ("appVersion", null_text(row, "app_version")),
        ("endUserId", null_text(row, "end_user_id")),
        ("endUserName", null_text(row, "end_user_name")),
        ("endUserEmail", null_text(row, "end_user_email")),
        ("screenshotId", null_text(row, "screenshot_id")),
        ("status", json::s(row.text("status").unwrap_or(""))),
        ("createdAt", json::i(row.int("created_at").unwrap_or(0))),
    ])
}

fn changelog_json(row: &db::Row) -> Json {
    json::obj([
        ("id", json::s(row.text("id").unwrap_or(""))),
        ("title", json::s(row.text("title").unwrap_or(""))),
        ("body", json::s(row.text("body_md").unwrap_or(""))),
        ("sortOrder", json::i(row.int("sort_order").unwrap_or(0))),
        ("publishedAt", null_int(row, "published_at")),
        ("createdAt", json::i(row.int("created_at").unwrap_or(0))),
    ])
}

fn mask_key(pk: &str) -> String {
    if pk.len() < 12 {
        return pk.to_string();
    }
    format!("{}…{}", &pk[..5], &pk[pk.len() - 4..])
}

fn null_text(row: &db::Row, col: &str) -> Json {
    match row.get(col) {
        Some(Value::Text(value)) => json::s(value.clone()),
        _ => Json::Null,
    }
}

fn null_int(row: &db::Row, col: &str) -> Json {
    match row.int(col) {
        Some(value) => json::i(value),
        None => Json::Null,
    }
}

fn opt_json(value: Option<&str>) -> Json {
    match value {
        Some(text) => json::s(text),
        None => Json::Null,
    }
}

fn value_to_json(value: &Value) -> Json {
    match value {
        Value::Text(text) => json::s(text.clone()),
        Value::Int(n) => json::i(*n),
        Value::Null => Json::Null,
        Value::Real(n) => json::n(*n),
    }
}

fn opt_text(value: Option<String>) -> Value {
    match value {
        Some(text) => Value::Text(text),
        None => Value::Null,
    }
}

fn greeting_value(value: Option<&Json>) -> Value {
    greeting_update(value).unwrap_or(Value::Null)
}

/// `Some` only for a string or JSON null, matching the dashboard's PATCH rule.
fn greeting_update(value: Option<&Json>) -> Option<Value> {
    match value {
        Some(Json::Str(text)) => Some(Value::Text(truncate_chars(text, 500))),
        Some(Json::Null) => Some(Value::Null),
        _ => None,
    }
}

fn budget_or(value: Option<&Json>, default: i64) -> i64 {
    json_budget(value.unwrap_or(&Json::Null)).unwrap_or(default)
}

fn json_budget(value: &Json) -> Option<i64> {
    let n = value.as_f64()?;
    if !n.is_finite() {
        return None;
    }
    Some(n.floor() as i64).map(|n| n.clamp(1, 1_000_000))
}

fn truncate_field(value: Option<&Json>, max: usize) -> Option<String> {
    value
        .and_then(Json::as_str)
        .map(|text| truncate_chars(text, max))
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn segment_ok(seg: &str) -> bool {
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && seg.len() <= 200
        && !seg.contains('\\')
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

fn parse_allowed_origins(csv: &str) -> Option<Vec<String>> {
    let parts: Vec<String> = csv
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn origin_allowed(origin: Option<&str>, allowed: Option<&[String]>) -> bool {
    let Some(allowed) = allowed else {
        return true;
    };
    let Some(origin) = origin else {
        return false;
    };
    let Some(host) = origin_host(origin) else {
        return false;
    };
    for entry in allowed {
        if let Some(base) = entry.strip_prefix("*.") {
            let base = base.to_ascii_lowercase();
            if base.is_empty() {
                continue;
            }
            let host_l = host.to_ascii_lowercase();
            if host_l == base || host_l.ends_with(&format!(".{base}")) {
                return true;
            }
            continue;
        }
        if entry == origin {
            return true;
        }
        if !entry.contains("://") && entry.eq_ignore_ascii_case(&host) {
            return true;
        }
    }
    false
}

fn origin_host(origin: &str) -> Option<String> {
    let rest = origin.split_once("://")?.1;
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or("");
    if hostport.is_empty() {
        return None;
    }
    if let Some(rest) = hostport.strip_prefix('[') {
        let end = rest.find(']')?;
        return Some(rest[..end].to_string());
    }
    Some(hostport.split(':').next()?.to_string())
}

fn rate_limited(message: &str, retry_after: i64) -> Response {
    json_res(429, &json::obj([("error", json::s(message))]))
        .header("Retry-After", &retry_after.to_string())
}

struct IpBucket {
    tokens: f64,
    last_ms: i64,
}

struct IpLimiter {
    buckets: HashMap<String, IpBucket>,
    last_prune_ms: i64,
}

fn ip_limiter() -> &'static Mutex<IpLimiter> {
    static IPS: std::sync::OnceLock<Mutex<IpLimiter>> = std::sync::OnceLock::new();
    IPS.get_or_init(|| {
        Mutex::new(IpLimiter {
            buckets: HashMap::new(),
            last_prune_ms: 0,
        })
    })
}

fn allow_ip(ip: &str) -> Result<(), i64> {
    let now = config::now_ms();
    let mut guard = ip_limiter().lock().unwrap_or_else(|err| err.into_inner());
    if now - guard.last_prune_ms > 5 * 60 * 1000 {
        guard
            .buckets
            .retain(|_, bucket| now - bucket.last_ms <= 10 * 60 * 1000);
        guard.last_prune_ms = now;
    }
    let bucket = guard
        .buckets
        .entry(ip.to_string())
        .or_insert(IpBucket {
            tokens: IP_CAPACITY,
            last_ms: now,
        });
    let elapsed = (now - bucket.last_ms) as f64 / 1000.0;
    if elapsed > 0.0 {
        bucket.tokens = (bucket.tokens + elapsed * IP_REFILL_PER_SEC).min(IP_CAPACITY);
        bucket.last_ms = now;
    }
    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        return Ok(());
    }
    let retry = ((1.0 - bucket.tokens) / IP_REFILL_PER_SEC).ceil().max(1.0) as i64;
    Err(retry)
}

fn utc_day_key(ms: i64) -> String {
    let days = ms.div_euclid(1000).div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn seconds_until_utc_midnight(ms: i64) -> i64 {
    let sod = ms.div_euclid(1000).rem_euclid(86_400);
    86_400 - sod
}

/// Howard Hinnant's `civil_from_days`, days since Unix epoch.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn is_allowed_mime(mime: &str) -> bool {
    let mime = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    mime == "image/jpeg" || mime == "image/png"
}

fn max_screenshot_bytes() -> usize {
    config::env_nonempty("MAX_SCREENSHOT_BYTES")
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_SHOT_BYTES)
}

fn uploads_dir(state: &AppState) -> PathBuf {
    if let Some(dir) = config::env_nonempty("UPLOADS_DIR") {
        return PathBuf::from(dir);
    }
    let from_db = state.pool.with(|db| {
        let rows = db.query("PRAGMA database_list", &[])?;
        let file = rows.into_iter().find_map(|row| {
            if row.text("name") == Some("main") {
                row.text("file").map(str::to_string)
            } else {
                None
            }
        });
        Ok(file)
    });
    if let Ok(Some(file)) = from_db {
        if let Some(parent) = Path::new(&file).parent() {
            return parent.join("uploads");
        }
    }
    config::backend_dir().join("databases/uploads")
}

fn save_screenshot(dir: &Path, bytes: &[u8]) -> std::io::Result<String> {
    std::fs::create_dir_all(dir)?;
    let id = crypto::random_uuid_v4()?;
    std::fs::write(dir.join(&id), bytes)?;
    Ok(id)
}

fn delete_screenshot_file(state: &AppState, id: &str) {
    if !segment_ok(id) {
        return;
    }
    let path = uploads_dir(state).join(id);
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => state.log.warn(
            "screenshot unlink failed",
            &[("id", json::s(id)), ("error", json::s(err.to_string()))],
        ),
    }
}

#[derive(Debug)]
enum MultipartError {
    Invalid,
    MissingFile,
}

fn parse_file_part(content_type: &str, body: &[u8]) -> Result<(String, Vec<u8>), MultipartError> {
    let boundary = boundary_token(content_type).ok_or(MultipartError::Invalid)?;
    let marker = format!("--{boundary}");
    let marker_b = marker.as_bytes();
    if marker_b.is_empty() {
        return Err(MultipartError::Invalid);
    }
    let mut cursor = 0;
    while let Some(rel) = find_bytes(&body[cursor..], marker_b) {
        let start = cursor + rel + marker_b.len();
        if body.get(start..start + 2) == Some(b"--") {
            break;
        }
        if body.get(start..start + 2) != Some(b"\r\n") {
            return Err(MultipartError::Invalid);
        }
        let header_at = start + 2;
        let Some(header_rel) = find_bytes(&body[header_at..], b"\r\n\r\n") else {
            return Err(MultipartError::Invalid);
        };
        let header_bytes = &body[header_at..header_at + header_rel];
        let data_at = header_at + header_rel + 4;
        let headers = String::from_utf8_lossy(header_bytes);
        let Some(next_rel) = find_bytes(&body[data_at..], marker_b) else {
            return Err(MultipartError::Invalid);
        };
        let mut data_end = data_at + next_rel;
        if data_end >= 2 && body.get(data_end - 2..data_end) == Some(b"\r\n") {
            data_end -= 2;
        }
        if disposition_is_file(&headers) {
            let mime = part_mime(&headers);
            return Ok((mime, body[data_at..data_end].to_vec()));
        }
        cursor = data_at + next_rel;
    }
    Err(MultipartError::MissingFile)
}

fn boundary_token(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    if !lower.starts_with("multipart/form-data") {
        return None;
    }
    for part in content_type.split(';').skip(1) {
        let part = part.trim();
        let (name, value) = part.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("boundary") {
            continue;
        }
        let value = value.trim().trim_matches('"').trim();
        if value.is_empty() {
            return None;
        }
        return Some(value.to_string());
    }
    None
}

fn disposition_is_file(headers: &str) -> bool {
    headers.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("content-disposition:")
            && (lower.contains("name=\"file\"") || lower.contains("name=file"))
    })
}

fn part_mime(headers: &str) -> String {
    for line in headers.lines() {
        if let Some(rest) = line.split_once(':') {
            if rest.0.trim().eq_ignore_ascii_case("content-type") {
                return rest
                    .1
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
            }
        }
    }
    String::new()
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|window| window == needle)
}

fn serve_js(path: &Path, cache: &str) -> Response {
    match std::fs::read(path) {
        Ok(bytes) => Response::bytes(200, "application/javascript; charset=utf-8", bytes)
            .set_header("Cache-Control", cache)
            .set_header("X-Content-Type-Options", "nosniff")
            .set_header("Access-Control-Allow-Origin", "*")
            .set_header("Cross-Origin-Resource-Policy", "cross-origin"),
        Err(_) => Response::text(404, "Widget asset missing"),
    }
}

fn bundle_path() -> PathBuf {
    config::backend_dir().join("../widget/dist/feedback-assistant.js")
}

fn html2canvas_path() -> PathBuf {
    config::backend_dir().join("../widget/dist/html2canvas-v1.js")
}

fn app_version() -> String {
    let path = config::backend_dir().join("../package.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return "0.0.0".to_string();
    };
    json::parse(&bytes)
        .ok()
        .and_then(|value| value.get_str("version").map(str::to_string))
        .unwrap_or_else(|| "0.0.0".to_string())
}

fn integrity_json() -> Json {
    let Ok(bytes) = std::fs::read(bundle_path()) else {
        return Json::Null;
    };
    let digest = crypto::sha384(&bytes);
    json::s(format!("sha384-{}", crypto::base64_encode(&digest)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Logger;
    use crate::routes::handle;
    use crate::state::TEST_ENV_LOCK;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DIR_SEQ: AtomicU64 = AtomicU64::new(0);
    static PEER_SEQ: AtomicU64 = AtomicU64::new(0);

    fn open_state() -> (AppState, std::path::PathBuf) {
        let _guard = TEST_ENV_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let n = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("fa-rs-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("databases")).unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"staticDir":"dist","database":{"db":"T","dbType":"sqlite","connectionString":"./databases/T.db"}}"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("JWT_SECRET", "test-secret-value-at-least-32-chars!!");
            std::env::remove_var("STRIPE_KEY");
            std::env::remove_var("STRIPE_ENDPOINT_SECRET");
            std::env::remove_var("NODE_ENV");
        }
        let state = AppState::open_in(&dir, 2, Logger::new(true)).expect("open");
        (state, dir)
    }

    fn body_of(res: &Response) -> Json {
        json::parse(&res.body).expect("json body")
    }

    fn auth_headers(req: &mut Request, signup: &Response) {
        let mut jar = Vec::new();
        for (name, value) in &signup.headers {
            if !name.eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            let pair = value.split(';').next().unwrap_or(value);
            if let Some((cookie, token)) = pair.split_once('=') {
                jar.push((cookie.to_string(), token.to_string()));
            }
        }
        if !jar.is_empty() {
            let serialized: Vec<String> = jar.iter().map(|(k, v)| format!("{k}={v}")).collect();
            req.set_test_header("cookie", &serialized.join("; "));
        }
        if let Some((_, token)) = jar.iter().find(|(name, _)| name == "csrf_token") {
            req.set_test_header("x-csrf-token", token);
        }
    }

    fn signup(state: &AppState, email: &str) -> Response {
        let mut req = Request::for_test("POST", "/api/signup");
        req.set_test_body(
            format!(r#"{{"email":"{email}","password":"secret1","name":"Ada"}}"#).into_bytes(),
        );
        let res = handle(state, req);
        assert_eq!(res.status, 201, "{}", String::from_utf8_lossy(&res.body));
        res
    }

    fn authed(state: &AppState, signup_res: &Response, method: &str, path: &str, raw: &str) -> Response {
        let mut req = Request::for_test(method, path);
        req.peer_ip = format!("peer-{}", PEER_SEQ.fetch_add(1, Ordering::Relaxed));
        if !raw.is_empty() {
            req.set_test_body(raw.as_bytes().to_vec());
        }
        auth_headers(&mut req, signup_res);
        handle(state, req)
    }

    #[test]
    fn empty_allowlist_accepts_any_origin() {
        assert!(origin_allowed(Some("https://evil.example"), None));
        assert!(origin_allowed(None, None));
    }

    #[test]
    fn wildcard_origin_matches_apex_and_subdomain_only() {
        let allowed = parse_allowed_origins("*.example.com").expect("list");
        assert!(origin_allowed(
            Some("https://shop.example.com"),
            Some(&allowed)
        ));
        assert!(origin_allowed(Some("https://example.com"), Some(&allowed)));
        assert!(!origin_allowed(Some("https://evil.com"), Some(&allowed)));
        assert!(!origin_allowed(
            Some("https://evil-example.com"),
            Some(&allowed)
        ));
    }

    #[test]
    fn parses_a_png_file_part() {
        let raw = b"------B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n------B--\r\n";
        let (mime, bytes) = parse_file_part("multipart/form-data; boundary=----B", raw).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"\x89PNG");
    }

    #[test]
    fn signup_org_then_cross_user_delete_is_404() {
        let (state, dir) = open_state();
        let ada = signup(&state, "ada@example.com");
        let created = authed(
            &state,
            &ada,
            "POST",
            "/api/apps",
            r#"{"name":"Widget","greeting":"Hello"}"#,
        );
        assert_eq!(created.status, 201, "{}", String::from_utf8_lossy(&created.body));
        let app_id = body_of(&created).get_str("id").unwrap().to_string();
        let public_key = body_of(&created).get_str("publicKey").unwrap().to_string();
        assert!(public_key.starts_with("pk_"));

        let listed = authed(&state, &ada, "GET", "/api/apps", "");
        assert_eq!(listed.status, 200);
        let masked = body_of(&listed).get("apps").and_then(Json::as_arr).unwrap()[0]
            .get_str("publicKey")
            .unwrap()
            .to_string();
        assert!(masked.contains('…'));
        assert_ne!(masked, public_key);

        let bob = signup(&state, "bob@example.com");
        let denied = authed(&state, &bob, "DELETE", &format!("/api/apps/{app_id}"), "");
        assert_eq!(denied.status, 404, "{}", String::from_utf8_lossy(&denied.body));

        let still = authed(&state, &ada, "GET", "/api/apps", "");
        assert_eq!(body_of(&still).get("apps").and_then(Json::as_arr).unwrap().len(), 1);

        let widget = Request::for_test("GET", &format!("/v1/projects/{public_key}/widget"));
        let greeting = handle(&state, widget);
        assert_eq!(greeting.status, 200);
        assert_eq!(body_of(&greeting).get_str("greeting"), Some("Hello"));
        let _ = widget;

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn widget_ingest_respects_origin_and_budget() {
        let (state, dir) = open_state();
        let ada = signup(&state, "ada2@example.com");
        let created = authed(
            &state,
            &ada,
            "POST",
            "/api/apps",
            r#"{"name":"Limited","allowedOrigins":"https://app.example.com","dailyBudget":1}"#,
        );
        assert_eq!(created.status, 201, "{}", String::from_utf8_lossy(&created.body));
        let key = body_of(&created).get_str("publicKey").unwrap().to_string();

        let mut bad = Request::for_test("POST", "/v1/submissions");
        bad.peer_ip = "budget-a".into();
        bad.set_test_header("x-project-key", &key);
        bad.set_test_header("origin", "https://evil.com");
        bad.set_test_header("content-type", "application/json");
        bad.set_test_body(br#"{"message":"nope"}"#.to_vec());
        let blocked = handle(&state, bad);
        assert_eq!(blocked.status, 403);

        let mut ok = Request::for_test("POST", "/v1/submissions");
        ok.peer_ip = "budget-b".into();
        ok.set_test_header("x-project-key", &key);
        ok.set_test_header("origin", "https://app.example.com");
        ok.set_test_header("content-type", "application/json");
        ok.set_test_body(br#"{"message":"first"}"#.to_vec());
        let first = handle(&state, ok);
        assert_eq!(first.status, 200, "{}", String::from_utf8_lossy(&first.body));

        let mut over = Request::for_test("POST", "/v1/submissions");
        over.peer_ip = "budget-c".into();
        over.set_test_header("x-project-key", &key);
        over.set_test_header("origin", "https://app.example.com");
        over.set_test_header("content-type", "application/json");
        over.set_test_body(br#"{"message":"second"}"#.to_vec());
        let second = handle(&state, over);
        assert_eq!(second.status, 429, "{}", String::from_utf8_lossy(&second.body));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn screenshot_then_submission_and_literal_reorder() {
        let (state, dir) = open_state();
        let ada = signup(&state, "ada3@example.com");
        let created = authed(&state, &ada, "POST", "/api/apps", r#"{"name":"Shots"}"#);
        let app_id = body_of(&created).get_str("id").unwrap().to_string();
        let key = body_of(&created).get_str("publicKey").unwrap().to_string();

        let raw = b"------B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n------B--\r\n";
        let mut up = Request::for_test("POST", "/v1/screenshots");
        up.peer_ip = "shot-1".into();
        up.set_test_header("x-project-key", &key);
        up.set_test_header("content-type", "multipart/form-data; boundary=----B");
        up.set_test_body(raw.to_vec());
        let uploaded = handle(&state, up);
        assert_eq!(uploaded.status, 200, "{}", String::from_utf8_lossy(&uploaded.body));
        let shot = body_of(&uploaded).get_str("screenshotId").unwrap().to_string();

        let mut sub = Request::for_test("POST", "/v1/submissions");
        sub.peer_ip = "shot-2".into();
        sub.set_test_header("x-project-key", &key);
        sub.set_test_header("content-type", "application/json");
        sub.set_test_body(format!(r#"{{"message":"with shot","screenshotId":"{shot}"}}"#).into_bytes());
        let saved = handle(&state, sub);
        assert_eq!(saved.status, 200, "{}", String::from_utf8_lossy(&saved.body));

        let entry = authed(
            &state,
            &ada,
            "POST",
            &format!("/api/apps/{app_id}/changelog"),
            r#"{"title":"One","body":"hi","publish":true}"#,
        );
        assert_eq!(entry.status, 201, "{}", String::from_utf8_lossy(&entry.body));
        let entry_id = body_of(&entry).get_str("id").unwrap().to_string();
        let reordered = authed(
            &state,
            &ada,
            "POST",
            &format!("/api/apps/{app_id}/changelog/reorder"),
            &format!(r#"{{"items":[{{"id":"{entry_id}","sortOrder":4}}]}}"#),
        );
        assert_eq!(reordered.status, 200, "{}", String::from_utf8_lossy(&reordered.body));

        let img = authed(&state, &ada, "GET", &format!("/api/screenshots/{shot}"), "");
        assert_eq!(img.status, 200, "{}", String::from_utf8_lossy(&img.body));
        assert_eq!(img.body, b"\x89PNG");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn patch_without_csrf_is_forbidden() {
        let (state, dir) = open_state();
        let ada = signup(&state, "ada4@example.com");
        let created = authed(&state, &ada, "POST", "/api/apps", r#"{"name":"Locked"}"#);
        let app_id = body_of(&created).get_str("id").unwrap().to_string();
        let mut req = Request::for_test("PATCH", &format!("/api/apps/{app_id}"));
        req.set_test_body(br#"{"name":"Nope"}"#.to_vec());
        auth_headers(&mut req, &ada);
        req.headers = crate::http::Request::for_test("GET", "/").headers;
        // Re-apply only the session cookie, not the CSRF header.
        let mut cookie_only = Request::for_test("PATCH", &format!("/api/apps/{app_id}"));
        cookie_only.set_test_body(br#"{"name":"Nope"}"#.to_vec());
        let cookie = ada
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, value)| value.split(';').next())
            .find(|pair| pair.starts_with("token="))
            .unwrap_or("")
            .to_string();
        cookie_only.set_test_header("cookie", &cookie);
        let res = handle(&state, cookie_only);
        assert_eq!(res.status, 403, "{}", String::from_utf8_lossy(&res.body));
        std::fs::remove_dir_all(&dir).ok();
    }
}
