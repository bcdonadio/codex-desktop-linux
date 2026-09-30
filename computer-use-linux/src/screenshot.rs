use crate::x11_display::{is_native_x11_session, with_x11_display, X11_CAPTURE_TIMEOUT};
use crate::{diagnostics::hydrate_session_bus_env, identity};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Seek, SeekFrom},
    os::fd::AsFd,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;
use zbus::{
    message::{Message, Type as MessageType},
    zvariant::{Fd, OwnedObjectPath, OwnedValue, Value},
    MatchRule, MessageStream, Proxy,
};

const PORTAL_REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const PORTAL_REQUEST_PATH_NAMESPACE: &str = "/org/freedesktop/portal/desktop/request";

pub const DEFAULT_SCREENSHOT_MAX_DIMENSION: u32 = 1920;
pub const DEFAULT_SCREENSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const ABSOLUTE_SCREENSHOT_MAX_DIMENSION: u32 = 4096;
pub const ABSOLUTE_SCREENSHOT_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_SCREENSHOT_JPEG_QUALITY: u8 = 80;
pub const MIN_SCREENSHOT_JPEG_QUALITY: u8 = 1;
pub const MAX_SCREENSHOT_JPEG_QUALITY: u8 = 95;
const MIN_SCREENSHOT_MAX_BYTES: usize = 1024;

#[derive(Debug, Clone)]
pub struct RawScreenshotCapture {
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub source: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ScreenshotCapture {
    pub mime_type: String,
    pub data_url: String,
    pub source: String,
    /// Width of the returned image payload.
    pub width: u32,
    /// Height of the returned image payload.
    pub height: u32,
    /// Coordinate-space width before payload downscaling.
    pub coordinate_width: u32,
    /// Coordinate-space height before payload downscaling.
    pub coordinate_height: u32,
    /// Returned pixels per coordinate-space pixel.
    pub scale: f32,
    pub resized: bool,
    pub bytes: usize,
    pub original_bytes: usize,
    pub max_bytes: usize,
    pub format: ScreenshotOutputFormat,
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ScreenshotPayloadOptions {
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_bytes: Option<usize>,
    pub scale: Option<f32>,
    pub format: Option<ScreenshotOutputFormat>,
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScreenshotOutputFormat {
    Png,
    Jpeg,
}

impl ScreenshotOutputFormat {
    fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ResolvedScreenshotPayloadOptions {
    max_width: u32,
    max_height: u32,
    max_bytes: usize,
    scale: f32,
    format: ScreenshotOutputFormat,
    quality: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScreenshotCleanup {
    DeletePath(PathBuf),
    Preserve,
}

impl ScreenshotPayloadOptions {
    fn resolve(self) -> ResolvedScreenshotPayloadOptions {
        let max_width = self
            .max_width
            .unwrap_or(DEFAULT_SCREENSHOT_MAX_DIMENSION)
            .clamp(1, ABSOLUTE_SCREENSHOT_MAX_DIMENSION);
        let max_height = self
            .max_height
            .unwrap_or(DEFAULT_SCREENSHOT_MAX_DIMENSION)
            .clamp(1, ABSOLUTE_SCREENSHOT_MAX_DIMENSION);
        let max_bytes = self
            .max_bytes
            .unwrap_or(DEFAULT_SCREENSHOT_MAX_BYTES)
            .clamp(MIN_SCREENSHOT_MAX_BYTES, ABSOLUTE_SCREENSHOT_MAX_BYTES);
        let scale = self
            .scale
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0)
            .min(1.0);
        let format = self.format.unwrap_or(ScreenshotOutputFormat::Png);
        let quality = self
            .quality
            .unwrap_or(DEFAULT_SCREENSHOT_JPEG_QUALITY)
            .clamp(MIN_SCREENSHOT_JPEG_QUALITY, MAX_SCREENSHOT_JPEG_QUALITY);

        ResolvedScreenshotPayloadOptions {
            max_width,
            max_height,
            max_bytes,
            scale,
            format,
            quality,
        }
    }
}

/// Environment variable forcing a single capture backend, skipping the
/// fallback chain. Accepts `gnome-shell`, `gnome-extension`, `portal`, `x11`,
/// or `gnome-screenshot`.
const SCREENSHOT_BACKEND_ENV: &str = "CODEX_COMPUTER_USE_SCREENSHOT_BACKEND";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScreenshotBackend {
    GnomeShell,
    GnomeExtension,
    Portal,
    X11,
    GnomeScreenshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScreenshotMode {
    Forced(ScreenshotBackend),
    AutomaticContainedExtension,
    AutomaticFallback,
}

fn select_screenshot_mode(
    forced: Option<ScreenshotBackend>,
    contained: bool,
    gnome_shell_owns_name: bool,
) -> ScreenshotMode {
    if let Some(backend) = forced {
        return ScreenshotMode::Forced(backend);
    }
    if contained && gnome_shell_owns_name {
        ScreenshotMode::AutomaticContainedExtension
    } else {
        ScreenshotMode::AutomaticFallback
    }
}

impl ScreenshotBackend {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gnome-shell" | "gnome_shell" | "shell" => Some(Self::GnomeShell),
            "gnome-extension" | "gnome_extension" | "extension" => Some(Self::GnomeExtension),
            "portal" | "xdg-portal" | "xdg_portal" => Some(Self::Portal),
            "x11" | "x11-native" | "x11_native" | "xgetimage" => Some(Self::X11),
            "gnome-screenshot" | "gnome_screenshot" => Some(Self::GnomeScreenshot),
            _ => None,
        }
    }

    async fn capture(self) -> Result<RawScreenshotCapture> {
        match self {
            Self::GnomeShell => capture_with_gnome_shell().await,
            Self::GnomeExtension => capture_with_gnome_extension().await,
            Self::Portal => capture_with_portal().await,
            Self::X11 => capture_with_x11().await,
            Self::GnomeScreenshot => capture_with_gnome_screenshot().await,
        }
    }
}

pub async fn capture_screenshot_raw() -> Result<RawScreenshotCapture> {
    hydrate_session_bus_env();

    // Explicit override: use exactly the requested backend, no fallback. Lets
    // background/systemd contexts pin `gnome-screenshot` when the DBus paths are
    // blocked, and aids debugging.
    let forced = forced_backend()?;
    let contained = std::env::var("CODEX_CONTAINED").is_ok_and(|value| value == "1");
    if let Some(forced) = forced {
        if forced == ScreenshotBackend::GnomeExtension && contained {
            return capture_with_gnome_extension_fd().await;
        }
        return forced.capture().await;
    }

    let gnome_shell_owns_name = if contained {
        session_bus_gnome_shell_owns_name().await.unwrap_or(false)
    } else {
        false
    };

    if select_screenshot_mode(None, contained, gnome_shell_owns_name)
        == ScreenshotMode::AutomaticContainedExtension
    {
        // A missing or outdated extension API is actionable setup guidance.
        // Do not continue to pathname backends that cannot cross the
        // contained process's /tmp namespace.
        return capture_with_gnome_extension_fd().await;
    }

    // The Shell and portal DBus paths fail for background processes (systemd
    // user services, non-interactive parent shells): GNOME Shell's
    // DBusSenderChecker rejects unknown bus names, and the portal cancels with
    // response code 2 when there is no foreground window. `gnome-screenshot`
    // claims an allowlisted bus name and works regardless, so it is the final
    // fallback. See issue #20.
    let gnome_error = match capture_with_gnome_shell().await {
        Ok(capture) => return Ok(capture),
        Err(error) => error,
    };
    let extension_error = match capture_with_gnome_extension().await {
        Ok(capture) => return Ok(capture),
        Err(error) => error,
    };
    let portal_error = match capture_with_portal().await {
        Ok(capture) => return Ok(capture),
        Err(error) => error,
    };
    // Native X11 only, and ahead of gnome-screenshot: gnome-screenshot 41 masks
    // everything outside the GDK monitor geometry, which is 1/4 of the frame at
    // window-scaling-factor 2 on MATE (issue #155). GetImage has no GDK layer.
    let x11_error = match capture_with_x11().await {
        Ok(capture) => return Ok(capture),
        Err(error) => error,
    };
    let cli_error = match capture_with_gnome_screenshot().await {
        Ok(capture) => return Ok(capture),
        Err(error) => error,
    };

    Err(anyhow!(
        "GNOME Shell screenshot failed: {gnome_error}; \
         GNOME Shell extension screenshot failed: {extension_error}; \
         XDG portal screenshot failed: {portal_error}; \
         native X11 screenshot failed: {x11_error}; \
         gnome-screenshot fallback failed: {cli_error}"
    ))
}

async fn session_bus_gnome_shell_owns_name() -> Result<bool> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus while checking GNOME Shell ownership")?;
    let dbus = zbus::fdo::DBusProxy::new(&connection)
        .await
        .context("failed to create session bus ownership proxy")?;
    let name = "org.gnome.Shell"
        .try_into()
        .context("invalid GNOME Shell session-bus name")?;
    dbus.name_has_owner(name)
        .await
        .context("failed to check whether GNOME Shell owns its session-bus name")
}

/// `GetImage` on the root window of a native X11 session. Pixels are device
/// pixels, the space xdotool/XTEST input and X11 window origins use.
async fn capture_with_x11() -> Result<RawScreenshotCapture> {
    if !is_native_x11_session() {
        bail!("not a native X11 session (needs DISPLAY on an X11, not Wayland, session)");
    }
    let image = with_x11_display(X11_CAPTURE_TIMEOUT, |display| display.capture_root()).await??;
    let (width, height) = (image.width, image.height);
    let bytes =
        tokio::task::spawn_blocking(move || encode_rgb_png(image.width, image.height, image.rgb))
            .await
            .context("X11 screenshot encoder task failed")??;
    Ok(RawScreenshotCapture {
        mime_type: "image/png".to_string(),
        bytes,
        source: "x11".to_string(),
        width,
        height,
    })
}

fn encode_rgb_png(width: u32, height: u32, rgb: Vec<u8>) -> Result<Vec<u8>> {
    let buffer = image::RgbImage::from_raw(width, height, rgb)
        .context("X11 root image did not match its dimensions")?;
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(buffer)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .context("failed to encode X11 screenshot PNG")?;
    Ok(out)
}

fn forced_backend() -> Result<Option<ScreenshotBackend>> {
    match std::env::var(SCREENSHOT_BACKEND_ENV) {
        Ok(value) if !value.trim().is_empty() => {
            ScreenshotBackend::parse(&value).map(Some).ok_or_else(|| {
                anyhow!(
                    "{SCREENSHOT_BACKEND_ENV}={value:?} is not a recognized backend \
                     (expected gnome-shell, gnome-extension, portal, x11, or gnome-screenshot)"
                )
            })
        }
        _ => Ok(None),
    }
}

pub async fn capture_screenshot() -> Result<ScreenshotCapture> {
    let raw = capture_screenshot_raw().await?;
    prepare_screenshot_payload(raw, ScreenshotPayloadOptions::default())
}

pub fn prepare_screenshot_payload(
    raw: RawScreenshotCapture,
    options: ScreenshotPayloadOptions,
) -> Result<ScreenshotCapture> {
    if raw.bytes.is_empty() {
        bail!("screenshot file was empty");
    }
    let (coordinate_width, coordinate_height) = png_dimensions(&raw.bytes)?;
    let original_bytes = raw.bytes.len();
    let options = options.resolve();
    let (target_width, target_height) =
        target_dimensions(coordinate_width, coordinate_height, options);

    let (bytes, width, height) = if options.format == ScreenshotOutputFormat::Png
        && target_width == coordinate_width
        && target_height == coordinate_height
        && original_bytes <= options.max_bytes
    {
        (raw.bytes, coordinate_width, coordinate_height)
    } else {
        encode_screenshot_to_fit_bytes(
            &raw.bytes,
            coordinate_width,
            coordinate_height,
            target_width,
            target_height,
            options,
        )?
    };

    let encoded = STANDARD.encode(&bytes);
    let scale = if coordinate_width == 0 {
        1.0
    } else {
        width as f32 / coordinate_width as f32
    };

    Ok(ScreenshotCapture {
        mime_type: options.format.mime_type().to_string(),
        data_url: format!("data:{};base64,{encoded}", options.format.mime_type()),
        source: raw.source,
        width,
        height,
        coordinate_width,
        coordinate_height,
        scale,
        resized: width != coordinate_width || height != coordinate_height,
        bytes: bytes.len(),
        original_bytes,
        max_bytes: options.max_bytes,
        format: options.format,
        quality: (options.format == ScreenshotOutputFormat::Jpeg).then_some(options.quality),
    })
}

async fn capture_with_gnome_shell() -> Result<RawScreenshotCapture> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        "org.gnome.Shell.Screenshot",
        "/org/gnome/Shell/Screenshot",
        "org.gnome.Shell.Screenshot",
    )
    .await
    .context("failed to create GNOME Shell screenshot proxy")?;
    let path = temp_png_path("gnome-shell");
    let filename = path
        .to_str()
        .context("temporary screenshot path is not valid UTF-8")?;
    let result = proxy.call("Screenshot", &(false, false, filename)).await;
    let (success, filename_used): (bool, String) = match result {
        Ok(result) => result,
        Err(error) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("GNOME Shell Screenshot call failed");
        }
    };

    if !success {
        cleanup_gnome_requested_path(&path);
        bail!("GNOME Shell reported screenshot failure");
    }

    read_png_as_capture(
        PathBuf::from(filename_used),
        "gnome-shell",
        ScreenshotCleanup::DeletePath(path),
    )
    .await
}

async fn capture_with_gnome_extension() -> Result<RawScreenshotCapture> {
    let path = temp_png_path("gnome-extension");
    let filename = path
        .to_str()
        .context("temporary screenshot path is not valid UTF-8")?;
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        identity::DBUS_SERVICE,
        identity::DBUS_OBJECT_PATH,
        identity::DBUS_SERVICE,
    )
    .await
    .context("failed to create Codex GNOME Shell extension proxy")?;
    let (ok, message): (bool, String) = match proxy.call("CaptureScreenshot", &(filename)).await {
        Ok(result) => result,
        Err(error) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("Codex GNOME Shell extension CaptureScreenshot call failed");
        }
    };
    if !ok {
        cleanup_gnome_requested_path(&path);
        bail!("Codex GNOME Shell extension refused screenshot: {message}");
    }

    read_png_as_capture(
        path.clone(),
        "gnome-shell-extension",
        ScreenshotCleanup::DeletePath(path),
    )
    .await
}

const GNOME_EXTENSION_FD_TIMEOUT: Duration = Duration::from_secs(20);
const GNOME_EXTENSION_FD_SETUP_HINT: &str = "run setup_window_targeting to install the GNOME Shell extension, then log out and back in to reload GNOME Shell";

async fn capture_with_gnome_extension_fd() -> Result<RawScreenshotCapture> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus for GNOME Shell extension screenshot")?;
    let proxy = Proxy::new(
        &connection,
        identity::DBUS_SERVICE,
        identity::DBUS_OBJECT_PATH,
        identity::DBUS_SERVICE,
    )
    .await
    .context("failed to create Codex GNOME Shell extension screenshot proxy")?;

    capture_png_to_fd(&proxy, &std::env::temp_dir(), GNOME_EXTENSION_FD_TIMEOUT)
        .await
        .map_err(add_gnome_extension_fd_guidance)
}

fn add_gnome_extension_fd_guidance(error: anyhow::Error) -> anyhow::Error {
    let unknown_method = error.chain().any(|cause| {
        cause.downcast_ref::<zbus::Error>().is_some_and(|error| {
            matches!(
                error,
                zbus::Error::MethodError(name, _, _)
                    if matches!(name.as_str(),
                        "org.freedesktop.DBus.Error.UnknownMethod"
                        | "org.freedesktop.DBus.Error.ServiceUnknown"
                        | "org.freedesktop.DBus.Error.NameHasNoOwner"
                    )
            )
        })
    });
    if unknown_method {
        error.context(format!(
            "the installed GNOME Shell extension does not support descriptor-based screenshots; {GNOME_EXTENSION_FD_SETUP_HINT}"
        ))
    } else {
        error
    }
}

async fn capture_png_to_fd(
    proxy: &Proxy<'_>,
    temp_dir: &Path,
    timeout: Duration,
) -> Result<RawScreenshotCapture> {
    let mut file = create_unlinked_screenshot_file(temp_dir)?;

    let call: zbus::Result<(bool, String)> = tokio::time::timeout(
        timeout,
        proxy.call("CaptureScreenshotToFd", &(Fd::from(file.as_fd()),)),
    )
    .await
    .context("timed out waiting for GNOME Shell extension CaptureScreenshotToFd")?;
    let (success, message) = call.map_err(|error| {
        anyhow!(error).context("GNOME Shell extension CaptureScreenshotToFd call failed")
    })?;
    if !success {
        bail!("GNOME Shell extension refused descriptor screenshot: {message}");
    }

    file.seek(SeekFrom::Start(0))
        .context("failed to rewind descriptor-based GNOME screenshot")?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .context("failed to read descriptor-based GNOME screenshot")?;
    if bytes.is_empty() {
        bail!("descriptor-based GNOME screenshot file was empty");
    }
    let (width, height) =
        png_dimensions(&bytes).context("descriptor-based GNOME screenshot was not a valid PNG")?;

    Ok(RawScreenshotCapture {
        mime_type: "image/png".to_string(),
        bytes,
        source: "gnome-shell-extension".to_string(),
        width,
        height,
    })
}

fn create_unlinked_screenshot_file(temp_dir: &Path) -> Result<File> {
    let path = temp_dir.join(format!(
        "computer-use-linux-fd-screenshot-{}.png",
        unique_suffix()
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .with_context(|| {
            format!(
                "failed to create private screenshot descriptor in {}",
                temp_dir.display()
            )
        })?;
    if let Err(error) = fs::remove_file(&path) {
        let _ = fs::remove_file(&path);
        return Err(error).with_context(|| {
            format!(
                "failed to unlink private screenshot descriptor {}",
                path.display()
            )
        });
    }
    Ok(file)
}

async fn capture_with_portal() -> Result<RawScreenshotCapture> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let token = request_token();
    // Some portals rewrite the request handle, so subscribe before calling Screenshot
    // and filter by the returned handle instead of subscribing after the call.
    let mut response_stream = portal_response_stream(&connection).await?;

    let portal_proxy = Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
    )
    .await
    .context("failed to create XDG portal screenshot proxy")?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    options.insert("interactive", Value::from(false));
    let handle: OwnedObjectPath = portal_proxy
        .call("Screenshot", &("", options))
        .await
        .context("XDG portal Screenshot call failed")?;

    let (response_code, results) = tokio::time::timeout(
        Duration::from_secs(20),
        wait_for_portal_response(&mut response_stream, handle.as_str()),
    )
    .await
    .context("timed out waiting for XDG portal screenshot response")??;

    if response_code != 0 {
        bail!("XDG portal screenshot was denied or cancelled with response code {response_code}");
    }

    let uri_value = results
        .get("uri")
        .context("XDG portal screenshot response did not include a uri")?;
    let uri: String = uri_value
        .try_clone()
        .context("failed to clone XDG portal screenshot uri")?
        .try_into()
        .context("XDG portal screenshot uri was not a string")?;
    let path = file_uri_to_path(&uri)?;

    read_png_as_capture(path, "xdg-desktop-portal", ScreenshotCleanup::Preserve).await
}

/// Upper bound on how long we wait for `gnome-screenshot` before killing it.
/// Matches the portal timeout: a hung capture must not block the tool forever.
const GNOME_SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(20);

async fn capture_with_gnome_screenshot() -> Result<RawScreenshotCapture> {
    let path = temp_png_path("gnome-screenshot");
    let filename = path
        .to_str()
        .context("temporary screenshot path is not valid UTF-8")?;

    // `-f <file>` writes a full-screen PNG without prompting; no portal, no
    // foreground window required. `tokio::process::Command` searches PATH and
    // provides an async, non-polling wait.
    let mut command = Command::new("gnome-screenshot");
    command
        .args(["-f", filename])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = match crate::command_runner::spawn_retrying_busy(&mut command).await {
        Ok(child) => child,
        Err(error) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("failed to spawn gnome-screenshot");
        }
    };

    // A hung capture must not block the tool forever, so bound the wait and
    // kill the child if it outlives the deadline.
    let status = match tokio::time::timeout(GNOME_SCREENSHOT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("failed to wait for gnome-screenshot");
        }
        Err(_) => {
            let _ = child.kill().await;
            cleanup_gnome_requested_path(&path);
            bail!("gnome-screenshot timed out");
        }
    };

    if !status.success() {
        cleanup_gnome_requested_path(&path);
        bail!("gnome-screenshot exited with {status}");
    }

    read_png_as_capture(
        path.clone(),
        "gnome-screenshot",
        ScreenshotCleanup::DeletePath(path),
    )
    .await
}

async fn portal_response_stream(connection: &zbus::Connection) -> Result<MessageStream> {
    let response_rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .interface(PORTAL_REQUEST_INTERFACE)?
        .member("Response")?
        .path_namespace(PORTAL_REQUEST_PATH_NAMESPACE)?
        .build();

    MessageStream::for_match_rule(response_rule, connection, None)
        .await
        .context("failed to subscribe to XDG portal screenshot responses")
}

async fn wait_for_portal_response(
    response_stream: &mut MessageStream,
    request_path: &str,
) -> Result<(u32, HashMap<String, OwnedValue>)> {
    loop {
        let response = response_stream
            .next()
            .await
            .context("XDG portal screenshot response stream ended")?
            .context("XDG portal screenshot response stream failed")?;

        if !portal_response_matches_path(&response, request_path) {
            continue;
        }

        return response
            .body()
            .deserialize()
            .context("failed to decode XDG portal screenshot response");
    }
}

fn portal_response_matches_path(response: &Message, request_path: &str) -> bool {
    response
        .header()
        .path()
        .is_some_and(|path| path.as_str() == request_path)
}

async fn read_png_as_capture(
    path: PathBuf,
    source: &str,
    cleanup: ScreenshotCleanup,
) -> Result<RawScreenshotCapture> {
    let result = read_png_as_capture_inner(&path, source);
    if let ScreenshotCleanup::DeletePath(path) = cleanup {
        let _ = fs::remove_file(path);
    }
    result
}

fn read_png_as_capture_inner(path: &Path, source: &str) -> Result<RawScreenshotCapture> {
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read screenshot file {}", path.display()))?;
    if bytes.is_empty() {
        bail!("screenshot file was empty: {}", path.display());
    }
    let (width, height) = png_dimensions(&bytes)?;
    Ok(RawScreenshotCapture {
        mime_type: "image/png".to_string(),
        bytes,
        source: source.to_string(),
        width,
        height,
    })
}

fn target_dimensions(
    width: u32,
    height: u32,
    options: ResolvedScreenshotPayloadOptions,
) -> (u32, u32) {
    let width_scale = options.max_width as f64 / width as f64;
    let height_scale = options.max_height as f64 / height as f64;
    let scale = f64::from(options.scale)
        .min(width_scale)
        .min(height_scale)
        .min(1.0);

    let target_width = ((width as f64 * scale).round() as u32).clamp(1, width);
    let target_height = ((height as f64 * scale).round() as u32).clamp(1, height);
    (target_width, target_height)
}

fn encode_screenshot_to_fit_bytes(
    raw: &[u8],
    original_width: u32,
    original_height: u32,
    mut target_width: u32,
    mut target_height: u32,
    options: ResolvedScreenshotPayloadOptions,
) -> Result<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(raw, image::ImageFormat::Png)
        .context("failed to decode screenshot PNG for encoding")?;

    loop {
        let bytes = if options.format == ScreenshotOutputFormat::Png
            && target_width == original_width
            && target_height == original_height
        {
            raw.to_vec()
        } else {
            let output = if target_width == original_width && target_height == original_height {
                img.clone()
            } else {
                img.resize_exact(target_width, target_height, FilterType::Lanczos3)
            };
            encode_image(&output, options)?
        };

        if bytes.len() <= options.max_bytes {
            return Ok((bytes, target_width, target_height));
        }

        if target_width == 1 && target_height == 1 {
            bail!(
                "screenshot payload is {} bytes at 1x1, over max_bytes {}",
                bytes.len(),
                options.max_bytes
            );
        }

        (target_width, target_height) = next_dimensions_for_byte_cap(
            target_width,
            target_height,
            bytes.len(),
            options.max_bytes,
        );
    }
}

fn encode_image(
    img: &image::DynamicImage,
    options: ResolvedScreenshotPayloadOptions,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    match options.format {
        ScreenshotOutputFormat::Png => {
            img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
                .context("failed to encode screenshot PNG")?;
        }
        ScreenshotOutputFormat::Jpeg => {
            let rgb = img.to_rgb8();
            JpegEncoder::new_with_quality(&mut out, options.quality)
                .encode_image(&rgb)
                .context("failed to encode screenshot JPEG")?;
        }
    }
    Ok(out)
}

fn next_dimensions_for_byte_cap(
    width: u32,
    height: u32,
    encoded_bytes: usize,
    max_bytes: usize,
) -> (u32, u32) {
    let shrink = ((max_bytes as f64 / encoded_bytes as f64).sqrt() * 0.9).clamp(0.1, 0.95);
    let mut next_width = ((width as f64 * shrink).floor() as u32).max(1);
    let mut next_height = ((height as f64 * shrink).floor() as u32).max(1);

    if next_width >= width && width > 1 {
        next_width = width - 1;
    }
    if next_height >= height && height > 1 {
        next_height = height - 1;
    }

    (next_width, next_height)
}

fn cleanup_gnome_requested_path(path: &Path) {
    let _ = fs::remove_file(path);
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        bail!("screenshot file was not a valid PNG");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        bail!("screenshot PNG had invalid dimensions {width}x{height}");
    }
    Ok((width, height))
}

fn file_uri_to_path(uri: &str) -> Result<PathBuf> {
    let Some(rest) = uri.strip_prefix("file://") else {
        bail!("unsupported screenshot uri: {uri}");
    };
    Ok(PathBuf::from(percent_decode(rest)))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                    continue;
                }
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

fn temp_png_path(source: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "computer-use-linux-{source}-{}.png",
        unique_suffix()
    ))
}

fn request_token() -> String {
    format!("computer_use_linux_{}", unique_suffix().replace('-', "_"))
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        os::fd::AsFd,
        os::unix::fs::PermissionsExt,
        process::{Child, Command, Stdio},
        sync::{Arc, Mutex},
    };
    use zbus::zvariant::Fd;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "computer-use-linux-screenshot-test-{name}-{}",
            unique_suffix()
        ))
    }

    fn valid_png(width: u32, height: u32) -> Vec<u8> {
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13_u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([24, 96, 160, 255]));
        encode_test_png(img)
    }

    fn noisy_png(width: u32, height: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(width, height);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            let r = ((x * 31 + y * 17) % 256) as u8;
            let g = ((x * 13 + y * 47) % 256) as u8;
            let b = ((x * 97 + y * 7) % 256) as u8;
            *pixel = image::Rgba([r, g, b, 255]);
        }
        encode_test_png(img)
    }

    fn encode_test_png(img: image::RgbaImage) -> Vec<u8> {
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[derive(Clone)]
    enum FdProducerReply {
        Write(Vec<u8>),
        Refuse(String),
        Wait,
    }

    struct FdScreenshotProducer {
        reply: FdProducerReply,
        received_mode: Arc<Mutex<Option<u32>>>,
    }

    struct PrivateBus {
        child: Child,
        address: String,
        _stdout: BufReader<std::process::ChildStdout>,
    }

    impl PrivateBus {
        fn start() -> Self {
            let mut child = Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("dbus-daemon must be installed for private-bus screenshot tests");
            let stdout = child.stdout.take().unwrap();
            let mut reader = BufReader::new(stdout);
            let mut address = String::new();
            reader
                .read_line(&mut address)
                .expect("dbus-daemon must print its private bus address");
            assert!(
                !address.trim().is_empty(),
                "dbus-daemon returned an empty address"
            );
            Self {
                child,
                address: address.trim().to_string(),
                _stdout: reader,
            }
        }

        fn builder(&self) -> zbus::Result<zbus::connection::Builder<'_>> {
            zbus::connection::Builder::address(self.address.as_str())
        }
    }

    impl Drop for PrivateBus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[zbus::interface(name = "com.openai.Codex.TestScreenshot")]
    impl FdScreenshotProducer {
        async fn capture_screenshot_to_fd(&self, fd: Fd<'_>) -> (bool, String) {
            use std::io::Write;

            let owned_fd = fd.as_fd().try_clone_to_owned().unwrap();
            drop(fd);
            let mut file = std::fs::File::from(owned_fd);
            let mode = file.metadata().unwrap().permissions().mode() & 0o777;
            *self.received_mode.lock().unwrap() = Some(mode);
            match &self.reply {
                FdProducerReply::Write(bytes) => {
                    file.write_all(bytes).unwrap();
                    (true, "captured".to_string())
                }
                FdProducerReply::Refuse(message) => (false, message.clone()),
                FdProducerReply::Wait => {
                    drop(file);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    (true, "late".to_string())
                }
            }
        }
    }

    async fn fd_test_proxy(
        reply: FdProducerReply,
    ) -> (
        PrivateBus,
        zbus::Connection,
        zbus::Connection,
        Proxy<'static>,
        Arc<Mutex<Option<u32>>>,
    ) {
        let bus = PrivateBus::start();
        let name = format!(
            "com.openai.Codex.TestScreenshot_{}",
            unique_suffix().replace('-', "_")
        );
        let received_mode = Arc::new(Mutex::new(None));
        let service = bus
            .builder()
            .unwrap()
            .name(name.as_str())
            .unwrap()
            .serve_at(
                "/com/openai/Codex/TestScreenshot",
                FdScreenshotProducer {
                    reply,
                    received_mode: received_mode.clone(),
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let connection = bus.builder().unwrap().build().await.unwrap();
        let proxy = Proxy::new_owned(
            connection.clone(),
            name,
            "/com/openai/Codex/TestScreenshot",
            "com.openai.Codex.TestScreenshot",
        )
        .await
        .unwrap();
        // The service connection remains open for the caller's test.
        // Bus is returned alongside both peers and shuts down when dropped.
        (bus, connection, service, proxy, received_mode)
    }

    fn raw_capture(bytes: Vec<u8>) -> RawScreenshotCapture {
        let (width, height) = png_dimensions(&bytes).unwrap();
        RawScreenshotCapture {
            mime_type: "image/png".to_string(),
            bytes,
            source: "test".to_string(),
            width,
            height,
        }
    }

    #[test]
    fn decodes_file_uri_percent_escapes() {
        assert_eq!(
            file_uri_to_path("file:///tmp/Codex%20Screenshot.png").unwrap(),
            PathBuf::from("/tmp/Codex Screenshot.png")
        );
    }

    #[test]
    fn parses_known_backend_names() {
        assert_eq!(
            ScreenshotBackend::parse("gnome-shell"),
            Some(ScreenshotBackend::GnomeShell)
        );
        assert_eq!(
            ScreenshotBackend::parse("gnome-extension"),
            Some(ScreenshotBackend::GnomeExtension)
        );
        assert_eq!(
            ScreenshotBackend::parse("  Portal "),
            Some(ScreenshotBackend::Portal)
        );
        assert_eq!(
            ScreenshotBackend::parse("GNOME_SCREENSHOT"),
            Some(ScreenshotBackend::GnomeScreenshot)
        );
        assert_eq!(
            ScreenshotBackend::parse("x11"),
            Some(ScreenshotBackend::X11)
        );
        assert_eq!(
            ScreenshotBackend::parse(" X11-Native "),
            Some(ScreenshotBackend::X11)
        );
        assert_eq!(ScreenshotBackend::parse("nonsense"), None);
    }

    #[tokio::test]
    async fn extension_fd_capture_transfers_png_and_leaves_no_named_file() {
        let temp_dir = std::env::temp_dir().join(format!("cua-fd-success-{}", unique_suffix()));
        fs::create_dir(&temp_dir).unwrap();
        let expected = valid_png(23, 17);
        let (_bus, client, _service, proxy, received_mode) =
            fd_test_proxy(FdProducerReply::Write(expected.clone())).await;

        let capture = capture_png_to_fd(&proxy, &temp_dir, Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(capture.bytes, expected);
        assert_eq!((capture.width, capture.height), (23, 17));
        assert_eq!(*received_mode.lock().unwrap(), Some(0o600));
        assert_eq!(fs::read_dir(&temp_dir).unwrap().count(), 0);
        assert_no_open_fd_under(&temp_dir);
        drop(client);
        fs::remove_dir(&temp_dir).unwrap();
    }

    #[tokio::test]
    async fn extension_fd_capture_rejects_refusal_empty_and_malformed_pngs() {
        for (reply, expected_error) in [
            (
                FdProducerReply::Refuse("denied by shell".into()),
                "denied by shell",
            ),
            (
                FdProducerReply::Write(Vec::new()),
                "screenshot file was empty",
            ),
            (
                FdProducerReply::Write(b"not a png".to_vec()),
                "not a valid PNG",
            ),
        ] {
            let temp_dir = std::env::temp_dir().join(format!("cua-fd-error-{}", unique_suffix()));
            fs::create_dir(&temp_dir).unwrap();
            let (_bus, client, _service, proxy, _) = fd_test_proxy(reply).await;

            let error = capture_png_to_fd(&proxy, &temp_dir, Duration::from_secs(1))
                .await
                .unwrap_err();

            assert!(error.to_string().contains(expected_error), "{error:#}");
            assert_eq!(fs::read_dir(&temp_dir).unwrap().count(), 0);
            assert_no_open_fd_under(&temp_dir);
            drop(client);
            fs::remove_dir(&temp_dir).unwrap();
        }
    }

    #[tokio::test]
    async fn extension_fd_capture_timeout_releases_its_unlinked_file() {
        let temp_dir = std::env::temp_dir().join(format!("cua-fd-timeout-{}", unique_suffix()));
        fs::create_dir(&temp_dir).unwrap();
        let (_bus, _client, _service, proxy, _) = fd_test_proxy(FdProducerReply::Wait).await;

        let error = capture_png_to_fd(&proxy, &temp_dir, Duration::from_millis(5))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("timed out"), "{error:#}");
        // zbus can retain a serialized request descriptor until its late
        // reply is drained. Wait for that protocol-owned duplicate to close;
        // the capture helper itself has already returned at its deadline.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(fs::read_dir(&temp_dir).unwrap().count(), 0);
        assert_no_open_fd_under(&temp_dir);
        fs::remove_dir(&temp_dir).unwrap();
    }

    #[tokio::test]
    async fn extension_fd_capture_reports_setup_guidance_for_missing_service_and_method() {
        let bus = PrivateBus::start();
        let connection = bus.builder().unwrap().build().await.unwrap();
        let temp_dir = std::env::temp_dir().join(format!("cua-fd-guidance-{}", unique_suffix()));
        fs::create_dir(&temp_dir).unwrap();
        let missing_service = Proxy::new(
            &connection,
            "com.openai.Codex.MissingScreenshotExtension",
            "/com/openai/Codex/Screenshot",
            "com.openai.Codex.Screenshot",
        )
        .await
        .unwrap();
        let error = capture_png_to_fd(&missing_service, &temp_dir, Duration::from_secs(1))
            .await
            .unwrap_err();
        let error = add_gnome_extension_fd_guidance(error);
        assert!(
            error.to_string().contains("setup_window_targeting"),
            "{error:#}"
        );

        let outdated_service = Proxy::new(
            &connection,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
        )
        .await
        .unwrap();
        let error = capture_png_to_fd(&outdated_service, &temp_dir, Duration::from_secs(1))
            .await
            .unwrap_err();
        let error = add_gnome_extension_fd_guidance(error);
        assert!(
            error.to_string().contains("setup_window_targeting"),
            "{error:#}"
        );
        assert!(
            error.to_string().contains("log out and back in"),
            "{error:#}"
        );
        assert_eq!(fs::read_dir(&temp_dir).unwrap().count(), 0);
        fs::remove_dir(&temp_dir).unwrap();
    }

    #[test]
    fn contained_gnome_capture_selection_preserves_forced_backends() {
        assert_eq!(
            select_screenshot_mode(Some(ScreenshotBackend::Portal), true, true,),
            ScreenshotMode::Forced(ScreenshotBackend::Portal)
        );
        assert_eq!(
            select_screenshot_mode(None, true, true),
            ScreenshotMode::AutomaticContainedExtension
        );
        assert_eq!(
            select_screenshot_mode(None, true, false),
            ScreenshotMode::AutomaticFallback
        );
        assert_eq!(
            select_screenshot_mode(None, false, true),
            ScreenshotMode::AutomaticFallback
        );
    }

    fn assert_no_open_fd_under(path: &Path) {
        for entry in fs::read_dir("/proc/self/fd").unwrap() {
            let link = fs::read_link(entry.unwrap().path()).unwrap();
            assert!(
                !link.starts_with(path),
                "temporary screenshot descriptor remains open: {}",
                link.display()
            );
        }
    }

    #[test]
    fn forced_backend_reads_env_override() {
        // Only this test touches SCREENSHOT_BACKEND_ENV, so no cross-test race.
        std::env::set_var(SCREENSHOT_BACKEND_ENV, "gnome-screenshot");
        assert_eq!(
            forced_backend().unwrap(),
            Some(ScreenshotBackend::GnomeScreenshot)
        );

        std::env::set_var(SCREENSHOT_BACKEND_ENV, "   ");
        assert_eq!(forced_backend().unwrap(), None);

        std::env::set_var(SCREENSHOT_BACKEND_ENV, "bogus");
        let error = forced_backend().unwrap_err();
        assert!(error.to_string().contains("not a recognized backend"));

        std::env::remove_var(SCREENSHOT_BACKEND_ENV);
        assert_eq!(forced_backend().unwrap(), None);
    }

    #[test]
    fn request_token_is_portal_safe() {
        let token = request_token();
        assert!(token.starts_with("computer_use_linux_"));
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }

    #[test]
    fn reads_png_dimensions_from_ihdr() {
        let png = valid_png(3840, 1080);

        assert_eq!(png_dimensions(&png).unwrap(), (3840, 1080));
    }

    #[test]
    fn default_payload_downscales_long_edge() {
        let capture =
            prepare_screenshot_payload(raw_capture(solid_png(4000, 1000)), Default::default())
                .unwrap();

        assert_eq!((capture.width, capture.height), (1920, 480));
        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (4000, 1000)
        );
        assert!(capture.resized);
        assert!(capture.bytes <= DEFAULT_SCREENSHOT_MAX_BYTES);
        assert!(capture.data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn larger_bounded_request_can_keep_more_detail() {
        let capture = prepare_screenshot_payload(
            raw_capture(solid_png(3000, 1000)),
            ScreenshotPayloadOptions {
                max_width: Some(3000),
                max_height: Some(3000),
                max_bytes: Some(DEFAULT_SCREENSHOT_MAX_BYTES),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!((capture.width, capture.height), (3000, 1000));
        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (3000, 1000)
        );
        assert!(!capture.resized);
    }

    #[test]
    fn byte_cap_downscales_until_payload_fits() {
        let capture = prepare_screenshot_payload(
            raw_capture(noisy_png(512, 512)),
            ScreenshotPayloadOptions {
                max_width: Some(512),
                max_height: Some(512),
                max_bytes: Some(20_000),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(capture.bytes <= 20_000);
        assert!(capture.width < 512);
        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (512, 512)
        );
        assert!(capture.resized);
    }

    #[test]
    fn jpeg_format_compresses_when_requested() {
        let capture = prepare_screenshot_payload(
            raw_capture(noisy_png(512, 512)),
            ScreenshotPayloadOptions {
                max_width: Some(512),
                max_height: Some(512),
                max_bytes: Some(DEFAULT_SCREENSHOT_MAX_BYTES),
                format: Some(ScreenshotOutputFormat::Jpeg),
                quality: Some(60),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(capture.mime_type, "image/jpeg");
        assert_eq!(capture.format, ScreenshotOutputFormat::Jpeg);
        assert_eq!(capture.quality, Some(60));
        assert_eq!((capture.width, capture.height), (512, 512));
        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (512, 512)
        );
        assert!(capture.bytes < capture.original_bytes);
        assert!(capture.data_url.starts_with("data:image/jpeg;base64,"));
    }

    #[tokio::test]
    async fn portal_capture_preserves_valid_returned_path() {
        let path = test_path("portal-valid");
        fs::write(&path, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            path.clone(),
            "xdg-desktop-portal",
            ScreenshotCleanup::Preserve,
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "xdg-desktop-portal");
        assert!(path.exists());
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn portal_capture_preserves_invalid_returned_path() {
        let path = test_path("portal-invalid");
        fs::write(&path, b"").unwrap();

        let error = read_png_as_capture(
            path.clone(),
            "xdg-desktop-portal",
            ScreenshotCleanup::Preserve,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("screenshot file was empty"));
        assert!(path.exists());
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn gnome_capture_deletes_backend_temp_path_on_success() {
        let path = test_path("gnome-valid");
        fs::write(&path, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            path.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(path.clone()),
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "gnome-shell");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn gnome_capture_deletes_backend_temp_path_on_parse_failure() {
        let path = test_path("gnome-invalid");
        fs::write(&path, b"").unwrap();

        let error = read_png_as_capture(
            path.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(path.clone()),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("screenshot file was empty"));
        assert!(!path.exists());
    }

    #[test]
    fn gnome_failure_cleanup_removes_requested_temp_path() {
        let path = test_path("gnome-pre-read-failure");
        fs::write(&path, b"partial").unwrap();

        cleanup_gnome_requested_path(&path);

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn gnome_deletes_requested_temp_path_and_preserves_unexpected_returned_path() {
        let requested = test_path("gnome-requested");
        let returned = test_path("gnome-returned");
        fs::write(&requested, b"partial").unwrap();
        fs::write(&returned, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            returned.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(requested.clone()),
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "gnome-shell");
        assert!(!requested.exists());
        assert!(returned.exists());
        let _ = fs::remove_file(returned);
    }
}
