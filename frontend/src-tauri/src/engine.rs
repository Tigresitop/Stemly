//! Gestión del "motor" de Stemly: el backend de separación empaquetado con PyInstaller.
//!
//! - Detecta si hay una GPU NVIDIA.
//! - Descarga el motor desde GitHub Releases (o una carpeta local, para pruebas),
//!   verificando el SHA-256 de cada parte y del archivo completo.
//! - Lo descomprime en una carpeta temporal y recién al final reemplaza al anterior,
//!   así una descarga fallida nunca deja la app sin motor.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Versión del motor que espera esta versión de la app.
pub const ENGINE_VERSION: &str = "0.1.0";
const RELEASE_BASE: &str = "https://github.com/Tigresitop/Stemly/releases/download";
pub const ENGINE_EXE: &str = "stemly-backend.exe";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineEntry {
    pub version: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub unpacked_size: u64,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub engines: HashMap<String, EngineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InstalledEngine {
    pub variant: String,
    pub version: String,
}

/// Progreso que se envía a la interfaz.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum Progress {
    Downloading { part: usize, parts: usize, downloaded: u64, total: u64 },
    Verifying,
    Extracting { done: u64, total: u64 },
    Finishing,
}

/// De dónde se descargan los motores.
#[derive(Debug, Clone)]
pub enum Source {
    Http(String),
    Dir(PathBuf),
}

impl Source {
    /// GitHub Releases por defecto. Para pruebas, la variable STEMLY_ENGINE_SOURCE
    /// puede apuntar a otra URL o a una carpeta local (ej. la carpeta `release`).
    pub fn from_env() -> Source {
        match std::env::var("STEMLY_ENGINE_SOURCE") {
            Ok(s) if s.starts_with("http://") || s.starts_with("https://") => {
                Source::Http(s.trim_end_matches('/').to_string())
            }
            Ok(s) if !s.trim().is_empty() => Source::Dir(PathBuf::from(s)),
            _ => Source::Http(format!("{RELEASE_BASE}/engine-v{ENGINE_VERSION}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Rutas: cada motor vive en su propia carpeta, así pueden estar los dos instalados
//   <root>/engines/gpu/   <root>/engines/cpu/   <root>/active.json
// ---------------------------------------------------------------------------

pub const VARIANTS: [&str; 2] = ["gpu", "cpu"];

pub fn is_variant(v: &str) -> bool {
    VARIANTS.contains(&v)
}

fn engines_root(root: &Path) -> PathBuf {
    root.join("engines")
}

pub fn engine_dir(root: &Path, variant: &str) -> PathBuf {
    engines_root(root).join(variant)
}

fn staging_dir(root: &Path, variant: &str) -> PathBuf {
    engines_root(root).join(format!("{variant}.new"))
}

fn download_dir(root: &Path) -> PathBuf {
    root.join("download")
}

fn active_file(root: &Path) -> PathBuf {
    root.join("active.json")
}

// ---------------------------------------------------------------------------
// Detección de GPU
// ---------------------------------------------------------------------------

/// Nombre de la GPU NVIDIA, si hay una con driver instalado.
pub fn detect_nvidia() -> Option<String> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name", "--format=csv,noheader"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: sin ventana de consola
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    (!name.is_empty()).then_some(name)
}

// ---------------------------------------------------------------------------
// Motores instalados
// ---------------------------------------------------------------------------

fn read_engine_json(dir: &Path) -> Option<InstalledEngine> {
    if !dir.join(ENGINE_EXE).is_file() {
        return None;
    }
    let text = fs::read_to_string(dir.join("engine.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// El motor de una variante, si está instalado.
pub fn installed_variant(root: &Path, variant: &str) -> Option<InstalledEngine> {
    read_engine_json(&engine_dir(root, variant)).filter(|e| e.variant == variant)
}

/// Todos los motores instalados.
pub fn installed_all(root: &Path) -> Vec<InstalledEngine> {
    VARIANTS.iter().filter_map(|v| installed_variant(root, v)).collect()
}

#[derive(Serialize, Deserialize)]
struct ActiveFile {
    variant: String,
}

/// El motor elegido para usar. Si el elegido ya no existe, cualquier otro instalado.
pub fn active(root: &Path) -> Option<InstalledEngine> {
    let wanted = fs::read_to_string(active_file(root))
        .ok()
        .and_then(|t| serde_json::from_str::<ActiveFile>(&t).ok())
        .map(|a| a.variant);
    if let Some(engine) = wanted.and_then(|v| installed_variant(root, &v)) {
        return Some(engine);
    }
    installed_all(root).into_iter().next()
}

/// Elige qué motor usar (tiene que estar instalado).
pub fn set_active(root: &Path, variant: &str) -> Result<InstalledEngine, String> {
    let engine = installed_variant(root, variant)
        .ok_or_else(|| format!("El motor {} no está instalado.", variant.to_uppercase()))?;
    let json = serde_json::to_string(&ActiveFile { variant: variant.to_string() }).unwrap_or_default();
    fs::write(active_file(root), json).map_err(|e| format!("No se pudo guardar la elección del motor: {e}"))?;
    Ok(engine)
}

/// Borra un motor para liberar espacio. Tiene que estar apagado.
pub fn remove(root: &Path, variant: &str) -> Result<(), String> {
    let dir = engine_dir(root, variant);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("No se pudo eliminar el motor: {e}"))?;
    }
    let was_active = fs::read_to_string(active_file(root))
        .ok()
        .and_then(|t| serde_json::from_str::<ActiveFile>(&t).ok())
        .is_some_and(|a| a.variant == variant);
    if was_active {
        let _ = fs::remove_file(active_file(root));
    }
    Ok(())
}

/// Las primeras versiones guardaban un solo motor en <root>/engine.
/// Lo mueve a la carpeta nueva para no tener que descargarlo otra vez.
pub fn migrate_legacy(root: &Path) {
    let old = root.join("engine");
    let Some(info) = read_engine_json(&old) else { return };
    if !is_variant(&info.variant) {
        return;
    }
    let target = engine_dir(root, &info.variant);
    if target.exists() {
        let _ = fs::remove_dir_all(&old);
        return;
    }
    if fs::create_dir_all(engines_root(root)).is_ok() && fs::rename(&old, &target).is_ok() {
        let _ = set_active(root, &info.variant);
    }
}

// ---------------------------------------------------------------------------
// Manifiesto
// ---------------------------------------------------------------------------

pub async fn fetch_manifest(client: &reqwest::Client, src: &Source) -> Result<Manifest, String> {
    let text = match src {
        Source::Http(base) => {
            let resp = client
                .get(format!("{base}/engines.json"))
                .send()
                .await
                .map_err(|e| format!("No se pudo conectar para descargar el motor: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!(
                    "No se encontró la lista de motores en GitHub (HTTP {}).",
                    resp.status().as_u16()
                ));
            }
            resp.text().await.map_err(|e| format!("Error al leer la lista de motores: {e}"))?
        }
        Source::Dir(dir) => fs::read_to_string(dir.join("engines.json"))
            .map_err(|e| format!("No se pudo leer {}: {e}", dir.join("engines.json").display()))?,
    };
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|e| format!("Lista de motores inválida: {e}"))?;
    for entry in manifest.engines.values() {
        for part in &entry.parts {
            if part.name.contains(['/', '\\']) || part.name.contains("..") {
                return Err(format!("Nombre de archivo no permitido: {}", part.name));
            }
        }
    }
    Ok(manifest)
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

/// Escribe al archivo final calculando las huellas y avisando el progreso.
struct Sink<'a> {
    out: BufWriter<File>,
    whole: Sha256,
    part: Sha256,
    part_bytes: u64,
    downloaded: u64,
    total: u64,
    part_index: usize,
    parts: usize,
    last: Instant,
    on: &'a (dyn Fn(Progress) + Send + Sync),
}

impl Sink<'_> {
    fn push(&mut self, data: &[u8]) -> Result<(), String> {
        self.out
            .write_all(data)
            .map_err(|e| format!("No se pudo escribir en disco (¿hay espacio libre?): {e}"))?;
        self.whole.update(data);
        self.part.update(data);
        self.part_bytes += data.len() as u64;
        self.downloaded += data.len() as u64;
        if self.last.elapsed() >= PROGRESS_INTERVAL {
            self.last = Instant::now();
            self.report();
        }
        Ok(())
    }

    fn report(&self) {
        (self.on)(Progress::Downloading {
            part: self.part_index + 1,
            parts: self.parts,
            downloaded: self.downloaded,
            total: self.total,
        });
    }
}

/// Descarga, verifica y descomprime el motor en una carpeta temporal.
/// No toca el motor actual: para usarlo hay que llamar a `activate`.
pub async fn download_and_extract(
    client: &reqwest::Client,
    src: &Source,
    variant: &str,
    root: &Path,
    on: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<PathBuf, String> {
    let manifest = fetch_manifest(client, src).await?;
    let entry = manifest
        .engines
        .get(variant)
        .ok_or_else(|| format!("No hay un motor \"{variant}\" disponible."))?
        .clone();

    let dl_dir = download_dir(root);
    fs::create_dir_all(&dl_dir).map_err(|e| format!("No se pudo crear {}: {e}", dl_dir.display()))?;
    let zip_path = dl_dir.join(&entry.file);
    let file = File::create(&zip_path).map_err(|e| format!("No se pudo crear la descarga: {e}"))?;

    let mut sink = Sink {
        out: BufWriter::with_capacity(1 << 20, file),
        whole: Sha256::new(),
        part: Sha256::new(),
        part_bytes: 0,
        downloaded: 0,
        total: entry.parts.iter().map(|p| p.size).sum(),
        part_index: 0,
        parts: entry.parts.len(),
        last: Instant::now(),
        on: on.as_ref(),
    };
    sink.report();

    for (i, part) in entry.parts.iter().enumerate() {
        sink.part_index = i;
        sink.part = Sha256::new();
        sink.part_bytes = 0;

        match src {
            Source::Http(base) => {
                let resp = client
                    .get(format!("{base}/{}", part.name))
                    .send()
                    .await
                    .map_err(|e| format!("Se cortó la conexión: {e}"))?;
                if !resp.status().is_success() {
                    return Err(format!(
                        "No se pudo descargar {} (HTTP {}).",
                        part.name,
                        resp.status().as_u16()
                    ));
                }
                let mut stream = resp.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| format!("Se cortó la descarga: {e}"))?;
                    sink.push(&chunk)?;
                }
            }
            Source::Dir(dir) => {
                let path = dir.join(&part.name);
                let mut f = File::open(&path)
                    .map_err(|e| format!("No se pudo abrir {}: {e}", path.display()))?;
                let mut buf = vec![0u8; 1 << 20];
                loop {
                    let n = f.read(&mut buf).map_err(|e| format!("Error al leer {}: {e}", path.display()))?;
                    if n == 0 {
                        break;
                    }
                    sink.push(&buf[..n])?;
                }
            }
        }

        let got = format!("{:x}", std::mem::take(&mut sink.part).finalize());
        if sink.part_bytes != part.size || !got.eq_ignore_ascii_case(&part.sha256) {
            drop(sink);
            let _ = fs::remove_file(&zip_path);
            return Err(format!(
                "La parte {} llegó incompleta o dañada. Probá de nuevo.",
                part.name
            ));
        }
    }
    sink.report();

    (on)(Progress::Verifying);
    sink.out.flush().map_err(|e| format!("No se pudo escribir en disco: {e}"))?;
    let whole = format!("{:x}", std::mem::take(&mut sink.whole).finalize());
    drop(sink);
    if !whole.eq_ignore_ascii_case(&entry.sha256) {
        let _ = fs::remove_file(&zip_path);
        return Err("El motor descargado no coincide con el original. Probá de nuevo.".into());
    }

    // Descomprimir (operación bloqueante: fuera del hilo asíncrono)
    let staged = staging_dir(root, variant);
    let zip_for_task = zip_path.clone();
    let staged_for_task = staged.clone();
    let on_extract = on.clone();
    tokio::task::spawn_blocking(move || extract(&zip_for_task, &staged_for_task, on_extract.as_ref()))
        .await
        .map_err(|e| format!("Error interno al descomprimir: {e}"))??;
    let _ = fs::remove_file(&zip_path);

    // Comprobar que es el motor esperado
    let info: InstalledEngine = fs::read_to_string(staged.join("engine.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or("El motor descargado está incompleto (falta engine.json).")?;
    if info.variant != variant || !staged.join(ENGINE_EXE).is_file() {
        return Err("El motor descargado no es el que se pidió.".into());
    }
    Ok(staged)
}

fn extract(zip_path: &Path, dest: &Path, on: &(dyn Fn(Progress) + Send + Sync)) -> Result<(), String> {
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| format!("No se pudo limpiar {}: {e}", dest.display()))?;
    }
    fs::create_dir_all(dest).map_err(|e| format!("No se pudo crear {}: {e}", dest.display()))?;

    let file = File::open(zip_path).map_err(|e| format!("No se pudo abrir la descarga: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("El archivo descargado no es válido: {e}"))?;

    let mut total = 0u64;
    for i in 0..archive.len() {
        total += archive.by_index(i).map(|f| f.size()).unwrap_or(0);
    }

    let mut done = 0u64;
    let mut last = Instant::now();
    on(Progress::Extracting { done, total });
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("Archivo dañado: {e}"))?;
        // enclosed_name evita rutas maliciosas tipo "../../Windows/..."
        let rel = entry.enclosed_name().ok_or("El archivo contiene una ruta no permitida.")?;
        let out_path = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("No se pudo crear carpeta: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear carpeta: {e}"))?;
        }
        let mut out = BufWriter::new(
            File::create(&out_path).map_err(|e| format!("No se pudo crear {}: {e}", out_path.display()))?,
        );
        io::copy(&mut entry, &mut out)
            .map_err(|e| format!("No se pudo descomprimir (¿hay espacio libre?): {e}"))?;
        done += entry.size();
        if last.elapsed() >= PROGRESS_INTERVAL {
            last = Instant::now();
            on(Progress::Extracting { done, total });
        }
    }
    on(Progress::Extracting { done: total, total });
    Ok(())
}

/// Instala el motor recién descargado en su carpeta y lo deja elegido.
/// Si ya había uno de la misma variante (actualización), debe estar apagado.
pub fn activate(root: &Path, staged: &Path, variant: &str) -> Result<InstalledEngine, String> {
    let dir = engine_dir(root, variant);
    if dir.exists() {
        // Primero se renombra (rápido) y después se borra, para no dejarlo a medias
        let old = engines_root(root).join(format!("{variant}.old"));
        if old.exists() {
            let _ = fs::remove_dir_all(&old);
        }
        fs::rename(&dir, &old).map_err(|e| format!("No se pudo reemplazar el motor anterior: {e}"))?;
        let _ = fs::remove_dir_all(&old);
    }
    fs::rename(staged, &dir).map_err(|e| format!("No se pudo instalar el motor: {e}"))?;
    let _ = fs::remove_dir_all(download_dir(root));
    set_active(root, variant)
}
