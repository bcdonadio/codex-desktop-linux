//! Direct uinput **absolute** pointer.
//!
//! ydotool's virtual device is relative-only (`EV=7`: SYN|KEY|REL), so its
//! `--absolute` is faked as "pin-to-corner + relative move", which the
//! compositor then distorts with pointer acceleration and fractional display
//! scaling — clicks land in the wrong place on multi-monitor / HiDPI setups.
//!
//! Here we create our own uinput device that exposes a true `ABS_X`/`ABS_Y`
//! axis whose range equals the **logical desktop size** (the same coordinate
//! space the portal screenshot reports). The compositor maps an absolute
//! device's axis range across the whole logical layout, so `ABS(x, y)` lands at
//! screenshot pixel `(x, y)` regardless of scaling — and with no approval
//! dialog (we already hold `/dev/uinput` access).

use std::thread::sleep;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use evdev::{
    uinput::VirtualDevice, AbsInfo, AbsoluteAxisCode, AttributeSet, EventType, InputEvent, KeyCode,
    PropType, RelativeAxisCode, UinputAbsSetup,
};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use = "pointer input may be clamped; inspect requested and emitted coordinates"]
pub(crate) struct PointerLanding {
    pub(crate) requested: (i32, i32),
    pub(crate) emitted: (i32, i32),
}

#[derive(Clone, Copy)]
struct AbsPointerGeometry {
    max_x: i32,
    max_y: i32,
}

impl AbsPointerGeometry {
    fn from_dimensions(width: i32, height: i32) -> Self {
        Self {
            max_x: width.max(1).saturating_sub(1),
            max_y: height.max(1).saturating_sub(1),
        }
    }

    fn axis_maxima(self) -> (i32, i32) {
        (self.max_x, self.max_y)
    }

    fn clamp_coordinates(self, x: i32, y: i32) -> (i32, i32) {
        (x.clamp(0, self.max_x), y.clamp(0, self.max_y))
    }

    fn landing_for(self, x: i32, y: i32) -> PointerLanding {
        PointerLanding {
            requested: (x, y),
            emitted: self.clamp_coordinates(x, y),
        }
    }
}

pub struct AbsPointer {
    device: VirtualDevice,
    geometry: AbsPointerGeometry,
}

impl AbsPointer {
    /// Create the absolute pointer sized to the logical desktop `width`×`height`
    /// (the portal screenshot dimensions). Blocks ~`settle` ms so libinput picks
    /// the device up before the first event.
    pub fn create(width: i32, height: i32) -> Result<Self> {
        Self::create_with_settle(width, height, true)
    }

    /// Create without the non-Mutter settle delay; Mutter readiness is confirmed
    /// by the server through InputMapping before this device is used.
    pub fn create_without_settle(width: i32, height: i32) -> Result<Self> {
        Self::create_with_settle(width, height, false)
    }

    fn create_with_settle(width: i32, height: i32, settle: bool) -> Result<Self> {
        let geometry = AbsPointerGeometry::from_dimensions(width, height);
        let (max_x, max_y) = geometry.axis_maxima();
        // value, min, max, fuzz, flat, resolution. resolution=1 unit/px.
        let abs_x =
            UinputAbsSetup::new(AbsoluteAxisCode::ABS_X, AbsInfo::new(0, 0, max_x, 0, 0, 1));
        let abs_y =
            UinputAbsSetup::new(AbsoluteAxisCode::ABS_Y, AbsInfo::new(0, 0, max_y, 0, 0, 1));
        let keys =
            AttributeSet::from_iter([KeyCode::BTN_LEFT, KeyCode::BTN_RIGHT, KeyCode::BTN_MIDDLE]);
        let relative_axes =
            AttributeSet::from_iter([RelativeAxisCode::REL_WHEEL, RelativeAxisCode::REL_HWHEEL]);
        // INPUT_PROP_DIRECT marks the device as a direct (absolute) pointer so
        // libinput maps its axes to screen coordinates rather than treating it
        // as a relative touchpad.
        let props = AttributeSet::from_iter([PropType::DIRECT]);

        let device = VirtualDevice::builder()
            .context("uinput builder (is /dev/uinput writable?)")?
            .name("codex-computer-use-linux absolute pointer")
            .with_properties(&props)?
            .with_absolute_axis(&abs_x)?
            .with_absolute_axis(&abs_y)?
            .with_relative_axes(&relative_axes)?
            .with_keys(&keys)?
            .build()
            .context("failed to create uinput absolute pointer device")?;

        // Other desktops have no compositor mapping acknowledgement.
        if settle {
            sleep(Duration::from_millis(500));
        }

        Ok(Self { device, geometry })
    }

    /// Move the pointer to absolute logical coordinates `(x, y)`.
    pub(crate) fn move_to(&mut self, x: i32, y: i32) -> Result<PointerLanding> {
        let landing = self.geometry.landing_for(x, y);
        self.emit_motion_frames(motion_frames(
            x,
            y,
            self.geometry.max_x,
            self.geometry.max_y,
        ))?;
        Ok(landing)
    }

    fn emit_motion_frames(&mut self, frames: [(i32, i32); 2]) -> Result<()> {
        for (x, y) in frames {
            self.device
                .emit(&[
                    InputEvent::new_now(EventType::ABSOLUTE.0, AbsoluteAxisCode::ABS_X.0, x),
                    InputEvent::new_now(EventType::ABSOLUTE.0, AbsoluteAxisCode::ABS_Y.0, y),
                ])
                .context("failed to emit absolute motion")?;
        }
        Ok(())
    }

    /// Optionally move to a target, then emit native Linux wheel deltas.
    /// `dx`/`dy` use REL_HWHEEL/REL_WHEEL units and signs, respectively.
    pub fn scroll(&mut self, target: Option<(i32, i32)>, dx: i32, dy: i32) -> Result<()> {
        let plan = scroll_plan(target, dx, dy, self.geometry.max_x, self.geometry.max_y);
        if let Some(frames) = plan.motion {
            self.emit_motion_frames(frames)?;
        }
        if !plan.wheel.is_empty() {
            self.device
                .emit(&plan.wheel)
                .context("failed to emit absolute pointer wheel motion")?;
        }
        Ok(())
    }

    /// Return the `/dev/input/eventN` node used by Mutter to recognize this
    /// virtual device.
    pub fn device_node_path(&mut self) -> Result<PathBuf> {
        self.device
            .enumerate_dev_nodes_blocking()
            .context("failed to enumerate the uinput device node")?
            .next()
            .transpose()
            .context("failed to read the uinput device node")?
            .ok_or_else(|| anyhow!("uinput device has no event node"))
    }

    /// Move to `(x, y)` then press+release `button` `count` times.
    pub(crate) fn click(
        &mut self,
        x: i32,
        y: i32,
        button: PointerButton,
        count: u32,
    ) -> Result<PointerLanding> {
        let landing = self.move_to(x, y)?;
        sleep(Duration::from_millis(30));
        let code = button.key_code();
        for _ in 0..count.max(1) {
            if let Err(error) = self
                .device
                .emit(&[InputEvent::new_now(EventType::KEY.0, code, 1)])
            {
                return Err(self.release_after_error(code, error.into()));
            }
            sleep(Duration::from_millis(30));
            if let Err(error) = self.release_button(code) {
                return Err(self.release_after_error(code, error));
            }
            sleep(Duration::from_millis(40));
        }
        Ok(landing)
    }

    /// Press at `(start)`, move to `(end)`, release — a drag with `button`.
    pub fn drag(
        &mut self,
        start: (i32, i32),
        end: (i32, i32),
        button: PointerButton,
    ) -> Result<()> {
        let code = button.key_code();
        // Drag currently reports backend success only; retain the landing
        // values explicitly so their intentional omission stays visible.
        let _start_landing = self.move_to(start.0, start.1)?;
        sleep(Duration::from_millis(30));
        if let Err(error) = self
            .device
            .emit(&[InputEvent::new_now(EventType::KEY.0, code, 1)])
        {
            return Err(self.release_after_error(code, error.into()));
        }
        sleep(Duration::from_millis(40));
        let _end_landing = match self.move_to(end.0, end.1) {
            Ok(landing) => landing,
            Err(error) => return Err(self.release_after_error(code, error)),
        };
        sleep(Duration::from_millis(40));
        if let Err(error) = self.release_button(code) {
            return Err(self.release_after_error(code, error));
        }
        Ok(())
    }

    fn release_button(&mut self, code: u16) -> Result<()> {
        self.device
            .emit(&[InputEvent::new_now(EventType::KEY.0, code, 0)])
            .context("failed to emit absolute pointer button release")
    }

    fn release_after_error(&mut self, code: u16, error: anyhow::Error) -> anyhow::Error {
        match self.release_button(code) {
            Ok(()) => anyhow!("{error:#}; sent a best-effort button release"),
            Err(release_error) => {
                anyhow!("{error:#}; best-effort button release also failed: {release_error:#}")
            }
        }
    }
}

fn motion_frames(x: i32, y: i32, width: i32, height: i32) -> [(i32, i32); 2] {
    let max_x = width.max(0);
    let max_y = height.max(0);
    let target = (x.clamp(0, max_x), y.clamp(0, max_y));
    // uinput tracks the last ABS value and can suppress a repeated coordinate
    // after another physical device moved the compositor cursor.
    let neighbor = |value: i32, max: i32| {
        if max == 0 {
            0
        } else if value < max {
            value + 1
        } else {
            value - 1
        }
    };
    [
        (neighbor(target.0, max_x), neighbor(target.1, max_y)),
        target,
    ]
}

fn wheel_events(dx: i32, dy: i32) -> Vec<InputEvent> {
    let mut events = Vec::with_capacity(2);
    if dy != 0 {
        events.push(InputEvent::new_now(
            EventType::RELATIVE.0,
            RelativeAxisCode::REL_WHEEL.0,
            dy,
        ));
    }
    if dx != 0 {
        events.push(InputEvent::new_now(
            EventType::RELATIVE.0,
            RelativeAxisCode::REL_HWHEEL.0,
            dx,
        ));
    }
    events
}

struct ScrollPlan {
    motion: Option<[(i32, i32); 2]>,
    wheel: Vec<InputEvent>,
}

fn scroll_plan(
    target: Option<(i32, i32)>,
    dx: i32,
    dy: i32,
    width: i32,
    height: i32,
) -> ScrollPlan {
    ScrollPlan {
        motion: target.map(|(x, y)| motion_frames(x, y, width, height)),
        wheel: wheel_events(dx, dy),
    }
}

/// Pointer buttons we can synthesize.
#[derive(Clone, Copy, Debug)]
pub enum PointerButton {
    Left,
    Right,
    Middle,
}

impl PointerButton {
    pub fn from_name(name: Option<&str>) -> Option<Self> {
        match name.unwrap_or("left").to_ascii_lowercase().as_str() {
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "middle" => Some(Self::Middle),
            _ => None,
        }
    }

    fn key_code(self) -> u16 {
        match self {
            Self::Left => KeyCode::BTN_LEFT.0,
            Self::Right => KeyCode::BTN_RIGHT.0,
            Self::Middle => KeyCode::BTN_MIDDLE.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{motion_frames, scroll_plan, wheel_events};
    use evdev::{EventType, RelativeAxisCode};

    #[test]
    fn repeated_motion_reasserts_both_axes_with_an_in_bounds_detour() {
        for (width, height, target) in [
            (1920, 1080, (0, 0)),
            (1920, 1080, (1920, 1080)),
            (1920, 1080, (-20, 5000)),
            (1, 1, (0, 0)),
            (1, 1, (1, 1)),
        ] {
            let max_x = width.max(1) - 1;
            let max_y = height.max(1) - 1;
            let frames = motion_frames(target.0, target.1, max_x, max_y);
            if max_x > 0 {
                assert_ne!(frames[0].0, frames[1].0, "x must change across SYN frames");
            }
            if max_y > 0 {
                assert_ne!(frames[0].1, frames[1].1, "y must change across SYN frames");
            }
            for (x, y) in frames {
                assert!((0..=max_x).contains(&x));
                assert!((0..=max_y).contains(&y));
            }
            assert_eq!(
                frames[1],
                (target.0.clamp(0, max_x), target.1.clamp(0, max_y))
            );
        }
    }

    #[test]
    fn wheel_events_use_native_axes_and_skip_zero_deltas() {
        let vertical = wheel_events(0, 5);
        assert_eq!(vertical.len(), 1);
        assert_eq!(vertical[0].event_type(), EventType::RELATIVE);
        assert_eq!(vertical[0].code(), RelativeAxisCode::REL_WHEEL.0);
        assert_eq!(vertical[0].value(), 5);

        let horizontal = wheel_events(-5, 0);
        assert_eq!(horizontal.len(), 1);
        assert_eq!(horizontal[0].code(), RelativeAxisCode::REL_HWHEEL.0);
        assert_eq!(horizontal[0].value(), -5);
        assert!(wheel_events(0, 0).is_empty());
    }

    #[test]
    fn untargeted_scroll_plan_emits_wheel_without_absolute_motion() {
        let plan = scroll_plan(None, 0, 5, 1920, 1080);
        assert!(plan.motion.is_none());
        assert_eq!(plan.wheel.len(), 1);
        assert_eq!(plan.wheel[0].event_type(), EventType::RELATIVE);
        assert_eq!(plan.wheel[0].code(), RelativeAxisCode::REL_WHEEL.0);
        assert_eq!(plan.wheel[0].value(), 5);

        let targeted = scroll_plan(Some((20, 30)), 0, 5, 1920, 1080);
        assert!(targeted.motion.is_some());
        assert_eq!(targeted.wheel.len(), 1);
    }
}

#[cfg(test)]
mod upstream_geometry_tests {
    use super::{AbsPointerGeometry, PointerButton};

    #[test]
    fn axis_range_ends_at_last_desktop_pixel() {
        let geometry = AbsPointerGeometry::from_dimensions(1920, 1080);

        assert_eq!(geometry.axis_maxima(), (1919, 1079));
    }

    #[test]
    fn pointer_landing_preserves_the_request_and_emitted_coordinates() {
        let geometry = AbsPointerGeometry::from_dimensions(1920, 1080);

        for (requested, emitted) in [
            ((640, 480), (640, 480)),
            ((1920, 1080), (1919, 1079)),
            ((-1, -1), (0, 0)),
            ((i32::MAX, i32::MAX), (1919, 1079)),
        ] {
            let landing = geometry.landing_for(requested.0, requested.1);
            assert_eq!(landing.requested, requested);
            assert_eq!(landing.emitted, emitted);
        }
    }

    #[test]
    fn unsupported_buttons_fall_through_to_other_backends() {
        assert!(matches!(
            PointerButton::from_name(None),
            Some(PointerButton::Left)
        ));
        assert!(matches!(
            PointerButton::from_name(Some("right")),
            Some(PointerButton::Right)
        ));
        assert!(matches!(
            PointerButton::from_name(Some("middle")),
            Some(PointerButton::Middle)
        ));

        for button in ["side", "extra", "forward", "back"] {
            assert!(
                PointerButton::from_name(Some(button)).is_none(),
                "{button} must fall through instead of becoming a left click"
            );
        }
    }
}
