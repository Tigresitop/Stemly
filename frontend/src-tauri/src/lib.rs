mod engine;

use std::fs::File;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

use engine::{InstalledEngine, Manifest, Progress, Source};

/// Motor en ejecución: el proceso y qué variante es.
#[derive(Default)]
struct EngineState {
    running: Mutex<Option<(Child, String)>>,
}

impl EngineState {
    /// Variante del motor que está corriendo, si hay uno.
    fn running_variant(&self) -> Option<String> {
        let mut guard = self.running.lock().unwrap();
        let alive = match guard.as_mut() {
            Some((child, _)) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        if !alive {
            *guard = None;
        }
        guard.as_ref().map(|(_, v)| v.clone())
    }

    fn stop(&self) {
        if let Some((mut child, _)) = self.running.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Apaga el motor solo si es de esa variante (para poder reemplazarlo o borrarlo).
    fn stop_if(&self, variant: &str) {
        if self.running_variant().as_deref() == Some(variant) {
            self.stop();
        }
    }
}

/// %LOCALAPPDATA%\com.tigresitop.stemly en Windows
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No se encontró la carpeta de datos: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
    Ok(dir)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Stemly/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("No se pudo preparar la conexión: {e}"))
}

fn check_variant(variant: &str) -> Result<(), String> {
    if engine::is_variant(variant) {
        Ok(())
    } else {
        Err("Motor no válido.".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    /// Motor elegido para usar
    installed: Option<InstalledEngine>,
    /// Todos los motores instalados
    available: Vec<InstalledEngine>,
    expected_version: String,
    running: bool,
    gpu: Option<String>,
    log_path: String,
}

#[tauri::command]
fn engine_info(app: AppHandle, state: State<'_, EngineState>) -> Result<EngineInfo, String> {
    let root = root(&app)?;
    engine::migrate_legacy(&root);
    Ok(EngineInfo {
        installed: engine::active(&root),
        available: engine::installed_all(&root),
        expected_version: engine::ENGINE_VERSION.to_string(),
        running: state.running_variant().is_some(),
        gpu: engine::detect_nvidia(),
        log_path: root.join("engine.log").display().to_string(),
    })
}

#[tauri::command]
async fn engine_manifest() -> Result<Manifest, String> {
    engine::fetch_manifest(&http_client()?, &Source::from_env()).await
}

/// Descarga e instala un motor, y lo deja elegido.
#[tauri::command]
async fn install_engine(
    app: AppHandle,
    state: State<'_, EngineState>,
    variant: String,
) -> Result<InstalledEngine, String> {
    check_variant(&variant)?;
    let root = root(&app)?;
    let emitter = app.clone();
    let on_progress: Arc<dyn Fn(Progress) + Send + Sync> = Arc::new(move |p: Progress| {
        let _ = emitter.emit("engine-progress", p);
    });

    // Mientras se descarga, el motor actual sigue funcionando
    let staged = engine::download_and_extract(
        &http_client()?,
        &Source::from_env(),
        &variant,
        &root,
        on_progress.clone(),
    )
    .await?;

    on_progress(Progress::Finishing);
    state.stop_if(&variant); // en Windows no se puede reemplazar un .exe en uso
    engine::activate(&root, &staged, &variant)
}

/// Elige un motor ya instalado (sin descargar nada).
#[tauri::command]
fn select_engine(app: AppHandle, variant: String) -> Result<InstalledEngine, String> {
    check_variant(&variant)?;
    engine::set_active(&root(&app)?, &variant)
}

/// Borra un motor instalado para liberar espacio.
#[tauri::command]
fn remove_engine(app: AppHandle, state: State<'_, EngineState>, variant: String) -> Result<(), String> {
    check_variant(&variant)?;
    state.stop_if(&variant);
    engine::remove(&root(&app)?, &variant)
}

/// Enciende el motor elegido. Si hay otro encendido, lo apaga primero.
#[tauri::command]
fn start_engine(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    let root = root(&app)?;
    let chosen = engine::active(&root).ok_or("No hay ningún motor instalado.")?;
    match state.running_variant() {
        Some(v) if v == chosen.variant => return Ok(()),
        Some(_) => state.stop(),
        None => {}
    }

    let dir = engine::engine_dir(&root, &chosen.variant);
    let exe = dir.join(engine::ENGINE_EXE);

    // La salida del motor va a un archivo, para poder revisar errores
    let log = File::create(root.join("engine.log")).map_err(|e| format!("No se pudo crear el registro: {e}"))?;
    let log_err = log.try_clone().map_err(|e| format!("No se pudo crear el registro: {e}"))?;

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir)
        .env("STEMLY_DATA_DIR", root.join("data"))
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: sin ventana de consola
    }

    let child = cmd.spawn().map_err(|e| format!("No se pudo encender el motor: {e}"))?;
    *state.running.lock().unwrap() = Some((child, chosen.variant));
    Ok(())
}

#[tauri::command]
fn stop_engine(state: State<'_, EngineState>) {
    state.stop();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init()) // abrir enlaces en el navegador
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            engine_manifest,
            install_engine,
            select_engine,
            remove_engine,
            start_engine,
            stop_engine
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar Stemly")
        .run(|app, event| {
            // Al cerrar la app, apagar el motor
            if let RunEvent::Exit = event {
                app.state::<EngineState>().stop();
            }
        });
}
