// Scholea desktop entrypoint (Tauri v2).
//
// The HTTP plugin lets the desktop build call non-CORS endpoints (e.g. PubMed
// E-utilities) directly, bypassing browser CORS — see §1 of the build spec.
// The FS plugin backs local exports (Word/PDF/LaTeX) and offline storage.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Scholea");
}
