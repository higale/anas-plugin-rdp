//! Validate complete gestures and pace optional timed input without blocking the RDP engine.
use anyhow::{Context, bail};
use ironrdp_client::rdp::{RdpInputEvent, RdpInputSender};
use ironrdp_pdu::input::{
    MousePdu,
    fast_path::{FastPathInputEvent, KeyboardFlags},
    mouse::PointerFlags,
};
use serde::Deserialize;
use serde_json::Value;
use smallvec::SmallVec;
use std::time::Duration;
use tokio::time::Instant;

pub type Events = SmallVec<[FastPathInputEvent; 2]>;
// Small bursts with settling time avoid overrunning remote Unicode input handling.
const TEXT_CHUNK_CHARACTERS: usize = 8;
const TEXT_CHUNK_WAIT_MS: u64 = 50;
pub const INPUT_TIMEOUT_MS: u64 = 300_000;
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Text {
        text: String,
    },
    Press {
        key: String,
    },
    Hotkey {
        keys: Vec<String>,
    },
    Key {
        code: u8,
        #[serde(default)]
        extended: bool,
        down: bool,
    },
    Move {
        x: u16,
        y: u16,
    },
    Button {
        x: u16,
        y: u16,
        button: Button,
        down: bool,
    },
    Wheel {
        x: u16,
        y: u16,
        delta: i16,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Button {
    Left,
    Right,
    Middle,
}
pub struct Batch {
    pub events: Events,
    pub position: Option<(u16, u16)>,
    pub animate_cursor: bool,
    steps: Vec<Step>,
}
pub fn key(code: u8, extended: bool, down: bool) -> FastPathInputEvent {
    let mut flags = if down {
        KeyboardFlags::empty()
    } else {
        KeyboardFlags::RELEASE
    };
    if extended {
        flags |= KeyboardFlags::EXTENDED;
    }
    FastPathInputEvent::KeyboardEvent(flags, code)
}
pub fn mouse(x: u16, y: u16, bits: u16, wheel: i16) -> FastPathInputEvent {
    FastPathInputEvent::MouseEvent(MousePdu {
        flags: PointerFlags::from_bits_retain(bits),
        x_position: x,
        y_position: y,
        number_of_wheel_rotation_units: wheel,
    })
}
fn named_key(name: &str) -> anyhow::Result<(u8, bool)> {
    static CODES: std::sync::LazyLock<std::collections::HashMap<String, u16>> =
        std::sync::LazyLock::new(|| {
            serde_json::from_str(include_str!("../../src/key-codes.json"))
                .expect("bundled scan codes")
        });
    let name = name.replace(['_', '-'], "").to_ascii_uppercase();
    let name = if name.len() == 1 && name.as_bytes()[0].is_ascii_uppercase() {
        format!("KEY{name}")
    } else if name.len() == 1 && name.as_bytes()[0].is_ascii_digit() {
        format!("DIGIT{name}")
    } else {
        match name.as_str() {
            "CTRL" | "CONTROL" => "CONTROLLEFT",
            "ALT" => "ALTLEFT",
            "SHIFT" => "SHIFTLEFT",
            "WIN" | "META" | "SUPER" => "METALEFT",
            "ESC" => "ESCAPE",
            "RETURN" => "ENTER",
            "LEFT" => "ARROWLEFT",
            "RIGHT" => "ARROWRIGHT",
            "UP" => "ARROWUP",
            "DOWN" => "ARROWDOWN",
            other => other,
        }
        .to_owned()
    };
    let code = CODES
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(&name))
        .map(|(_, code)| *code)
        .context("unknown key name; use uppercase names such as PAGEDOWN, PAGEUP, ENTER, CTRL or ALTRIGHT")?;
    Ok(((code & 255) as u8, code > 255))
}
struct Step {
    end: usize,
    wait_ms: Option<u64>,
}
fn push_step(
    events: &mut Events,
    steps: &mut Vec<Step>,
    values: impl IntoIterator<Item = FastPathInputEvent>,
    wait_ms: Option<u64>,
) {
    events.extend(values);
    steps.push(Step {
        end: events.len(),
        wait_ms,
    });
}
pub fn batch(value: &Value, width: u32, height: u32) -> anyhow::Result<Batch> {
    let actions = value.as_array().context("actions must be an array")?;
    if serde_json::to_vec(value)?.len() > 12000 {
        bail!("serialized actions exceed 12000 bytes");
    }
    if actions.is_empty() || actions.len() > 64 {
        bail!("expected 1 to 64 actions");
    }
    let mut events = Events::new();
    let mut steps = Vec::new();
    for value in actions {
        let action: Action = serde_json::from_value(value.clone())
            .map_err(|_| anyhow::anyhow!("invalid action fields"))?;
        let (x, y, bits, wheel) = match action {
            Action::Text { text } => {
                if text.is_empty() || text.chars().count() > 4096 {
                    bail!("expected 1 to 4096 text characters");
                }
                // Keep each character's complete UTF-16 down/up sequence together.
                // Protocol packet splitting alone does not pace remote text processing.
                let characters: Vec<_> = text.chars().collect();
                for (index, chunk) in characters.chunks(TEXT_CHUNK_CHARACTERS).enumerate() {
                    let unicode = chunk.iter().flat_map(|character| {
                        let mut buffer = [0u16; 2];
                        let units = character.encode_utf16(&mut buffer);
                        let mut values = Events::new();
                        for flags in [KeyboardFlags::empty(), KeyboardFlags::RELEASE] {
                            values.extend(units.iter().map(|&unit| {
                                FastPathInputEvent::UnicodeKeyboardEvent(flags, unit)
                            }));
                        }
                        values
                    });
                    push_step(
                        &mut events,
                        &mut steps,
                        unicode,
                        if index == 0 {
                            None
                        } else {
                            Some(TEXT_CHUNK_WAIT_MS)
                        },
                    );
                }
                // Include the final settling period in this action, including across
                // separate calls or consecutive text actions with interval_ms = 0.
                push_step(&mut events, &mut steps, [], Some(TEXT_CHUNK_WAIT_MS));
                continue;
            }
            Action::Press { key: name } => {
                let (code, extended) = named_key(&name)?;
                push_step(&mut events, &mut steps, [key(code, extended, true)], None);
                push_step(
                    &mut events,
                    &mut steps,
                    [key(code, extended, false)],
                    Some(50),
                );
                continue;
            }
            Action::Hotkey { keys } => {
                if !(2..=8).contains(&keys.len()) {
                    bail!("expected 2 to 8 chord keys");
                }
                let keys = keys
                    .iter()
                    .map(|name| named_key(name))
                    .collect::<anyhow::Result<Vec<_>>>()?;
                for index in 0..keys.len() {
                    if keys[..index].contains(&keys[index]) {
                        bail!("duplicate chord key");
                    }
                }
                push_step(
                    &mut events,
                    &mut steps,
                    keys.iter()
                        .map(|&(code, extended)| key(code, extended, true)),
                    None,
                );
                push_step(
                    &mut events,
                    &mut steps,
                    keys.iter()
                        .rev()
                        .map(|&(code, extended)| key(code, extended, false)),
                    Some(50),
                );
                continue;
            }
            Action::Key {
                code,
                extended,
                down,
            } => {
                if code == 0 || code > 127 {
                    bail!("invalid scan code");
                }
                push_step(&mut events, &mut steps, [key(code, extended, down)], None);
                continue;
            }
            Action::Move { x, y } => (x, y, 0x0800, 0),
            Action::Button { x, y, button, down } => {
                let button = match button {
                    Button::Left => 0x1000,
                    Button::Right => 0x2000,
                    Button::Middle => 0x4000,
                };
                (x, y, button | if down { 0x8000 } else { 0 }, 0)
            }
            Action::Wheel { x, y, delta } => {
                if delta == 0 || !(-256..=255).contains(&delta) {
                    bail!("invalid wheel delta");
                }
                (x, y, 0x0200, delta)
            }
        };
        if u32::from(x) >= width || u32::from(y) >= height {
            bail!("position outside desktop");
        }
        push_step(&mut events, &mut steps, [mouse(x, y, bits, wheel)], None);
    }
    let position = mouse_position(&events);
    let animate_cursor = ends_with_mouse_move(&events);
    Ok(Batch {
        events,
        position,
        animate_cursor,
        steps,
    })
}
fn mouse_position(events: &[FastPathInputEvent]) -> Option<(u16, u16)> {
    events.iter().rev().find_map(|event| match event {
        FastPathInputEvent::MouseEvent(mouse) => Some((mouse.x_position, mouse.y_position)),
        _ => None,
    })
}
// Presentation hint only; this never inserts or delays an input event.
fn ends_with_mouse_move(events: &[FastPathInputEvent]) -> bool {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            FastPathInputEvent::MouseEvent(mouse) => Some(mouse.flags == PointerFlags::MOVE),
            _ => None,
        })
        .unwrap_or(false)
}

impl Batch {
    pub fn interval(&self, value: Option<&Value>) -> anyhow::Result<Duration> {
        let millis = match value {
            None => 50,
            Some(value) => value.as_u64().context("invalid interval")?,
        };
        if millis > 1000 {
            bail!("input interval exceeds the per-action limit");
        }
        Ok(Duration::from_millis(millis))
    }
    pub fn duration(&self, interval: Duration) -> Duration {
        self.steps
            .iter()
            .skip(1)
            .map(|step| step.wait_ms.map_or(interval, Duration::from_millis))
            .sum()
    }
}
/// One bounded in-flight gesture; callers keep polling the RDP engine between steps.
pub struct TimedInput {
    batch: Batch,
    interval: Duration,
    next: usize,
    pub next_at: Instant,
    pub deadline: Instant,
    step_position: Option<(u16, u16)>,
    step_animate_cursor: bool,
}
impl TimedInput {
    pub fn new(batch: Batch, interval: Duration, now: Instant, deadline: Instant) -> Self {
        Self {
            batch,
            interval,
            next: 0,
            next_at: now,
            deadline,
            step_position: None,
            step_animate_cursor: false,
        }
    }
    pub fn advance(&mut self, input: &RdpInputSender, now: Instant) -> anyhow::Result<bool> {
        if self.next == self.batch.steps.len() {
            return Ok(true);
        }
        if now >= self.deadline {
            bail!("RDP_INPUT_TIMEOUT");
        }
        if now < self.next_at {
            return Ok(false);
        }
        let start = if self.next == 0 {
            0
        } else {
            self.batch.steps[self.next - 1].end
        };
        let end = self.batch.steps[self.next].end;
        let events: Events = self.batch.events[start..end].iter().cloned().collect();
        if !events.is_empty() {
            input
                .try_send(RdpInputEvent::FastPath(events.clone()))
                .map_err(|_| anyhow::anyhow!("RDP_INPUT_UNAVAILABLE"))?;
        }
        self.step_position = mouse_position(&events);
        self.step_animate_cursor = ends_with_mouse_move(&events);
        self.next += 1;
        // Schedule from the actual send time: a delayed tick must never burst old steps together.
        if let Some(step) = self.batch.steps.get(self.next) {
            self.next_at = now + step.wait_ms.map_or(self.interval, Duration::from_millis);
        }
        Ok(self.next == self.batch.steps.len())
    }
    pub fn position(&self) -> Option<(u16, u16)> {
        self.step_position
    }
    pub fn animate_cursor(&self) -> bool {
        self.step_animate_cursor
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn queued(receiver: &mut tokio::sync::mpsc::Receiver<RdpInputEvent>) -> Events {
        let RdpInputEvent::FastPath(events) = receiver.try_recv().expect("queued input") else {
            panic!("unexpected input")
        };
        events
    }
    #[test]
    fn cursor_animation_hint_preserves_exact_mouse_events_and_action_timing() {
        let moves = batch(&json!([{"type":"move","x":40,"y":50}]), 100, 80).unwrap();
        assert!(moves.animate_cursor);
        assert_eq!(moves.duration(Duration::from_millis(50)), Duration::ZERO);
        assert_eq!(&moves.events[..], &[mouse(40, 50, 0x0800, 0)]);
        let click = batch(
            &json!([
                {"type":"move","x":40,"y":50},
                {"type":"button","x":40,"y":50,"button":"left","down":true},
                {"type":"button","x":40,"y":50,"button":"left","down":false}
            ]),
            100,
            80,
        )
        .unwrap();
        assert!(!click.animate_cursor);
        let interval = Duration::from_millis(50);
        assert_eq!(click.duration(interval), Duration::from_millis(100));
        let now = Instant::now();
        let mut timed = TimedInput::new(click, interval, now, now + Duration::from_secs(1));
        let (sender, mut receiver) = RdpInputSender::channel(4);
        for (step, flags) in [0x0800, 0x9000, 0x1000].into_iter().enumerate() {
            assert_eq!(
                timed
                    .advance(&sender, now + interval * step as u32)
                    .unwrap(),
                step == 2
            );
            assert_eq!(timed.position(), Some((40, 50)));
            assert_eq!(timed.animate_cursor(), step == 0);
            assert_eq!(&queued(&mut receiver)[..], &[mouse(40, 50, flags, 0)]);
            assert!(
                receiver.try_recv().is_err(),
                "Animation must never send intermediate mouse events"
            );
        }
        let wheel = batch(
            &json!([{"type":"wheel","x":40,"y":50,"delta":-120}]),
            100,
            80,
        )
        .unwrap();
        assert!(!wheel.animate_cursor);
        assert_eq!(&wheel.events[..], &[mouse(40, 50, 0x0200, -120)]);
    }
    #[test]
    fn page_keys_accept_documented_names_and_emit_extended_presses_and_chords() {
        for (code, names) in [
            (81, ["PAGEDOWN", "PageDown", "page_down", "page-down"]),
            (73, ["PAGEUP", "PageUp", "page_up", "page-up"]),
        ] {
            for name in names {
                let prepared = batch(&json!([{"type":"press","key":name}]), 100, 80).unwrap();
                assert_eq!(
                    &prepared.events[..],
                    &[key(code, true, true), key(code, true, false)]
                );
                let chord =
                    batch(&json!([{"type":"hotkey","keys":["CTRL",name]}]), 100, 80).unwrap();
                assert_eq!(
                    &chord.events[..],
                    &[
                        key(29, false, true),
                        key(code, true, true),
                        key(code, true, false),
                        key(29, false, false)
                    ]
                );
            }
        }
    }
    #[test]
    fn named_key_normalization_preserves_short_names_and_rejects_unknown_or_duplicate_keys() {
        for (name, code, extended) in [
            ("c_t-r_l", 29, false),
            ("a", 30, false),
            ("F-1", 59, false),
            ("alt_right", 56, true),
        ] {
            let prepared = batch(&json!([{"type":"press","key":name}]), 100, 80).unwrap();
            assert_eq!(
                &prepared.events[..],
                &[key(code, extended, true), key(code, extended, false)]
            );
        }
        for name in ["", "_-", "-", "PAGE DOWN", "PAGE_DOW"] {
            assert!(batch(&json!([{"type":"press","key":name}]), 100, 80).is_err());
        }
        let duplicate = batch(
            &json!([{"type":"hotkey","keys":["CTRL","c_t-r_l"]}]),
            100,
            80,
        )
        .err()
        .expect("normalized duplicate keys must be rejected");
        assert!(duplicate.to_string().contains("duplicate chord key"));
    }
    #[test]
    fn unknown_named_key_rejects_the_whole_batch_with_actionable_error() {
        for action in [
            json!({"type":"press","key":"PAGE_DOW"}),
            json!({"type":"hotkey","keys":["CTRL","PAGE_DOW"]}),
        ] {
            let error = batch(
                &json!([{"type":"key","code":29,"down":true}, action]),
                100,
                80,
            )
            .err()
            .expect("invalid key rejects the sequence before dispatch");
            assert!(error.to_string().contains("unknown key name"));
            assert!(error.to_string().contains("PAGEDOWN"));
        }
    }
    #[test]
    fn text_preserves_unicode_whitespace_and_surrogate_pairs_without_extra_keys() {
        let text = " 你A🐟e\u{301}\r\n\t\"\\ _- ";
        let prepared = batch(&json!([{"type":"text","text":text}]), 100, 80).unwrap();
        let mut downs = Vec::new();
        let mut ups = Vec::new();
        for event in &prepared.events {
            match event {
                FastPathInputEvent::UnicodeKeyboardEvent(flags, unit) if flags.is_empty() => {
                    downs.push(*unit)
                }
                FastPathInputEvent::UnicodeKeyboardEvent(flags, unit)
                    if *flags == KeyboardFlags::RELEASE =>
                {
                    ups.push(*unit)
                }
                other => panic!("unrequested input: {other:?}"),
            }
        }
        assert_eq!(downs, text.encode_utf16().collect::<Vec<_>>());
        assert_eq!(ups, downs);
        assert_eq!(
            prepared.duration(prepared.interval(None).unwrap()),
            Duration::from_millis((text.chars().count().div_ceil(8) * 50) as u64)
        );
        let fish = batch(&json!([{"type":"text","text":"🐟"}]), 100, 80).unwrap();
        assert_eq!(
            &fish.events[..],
            &[
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), 0xd83d),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), 0xdc1f),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, 0xd83d),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, 0xdc1f),
            ]
        );
    }
    #[test]
    fn text_is_one_action_and_can_mix_with_raw_holds_presses_and_chords() {
        let prepared = batch(
            &json!([
                {"type":"key","code":29,"down":true},
                {"type":"text","text":"hello"},
                {"type":"press","key":"ENTER"},
                {"type":"hotkey","keys":["CTRL","ENTER"]},
                {"type":"key","code":29,"down":false}
            ]),
            100,
            80,
        )
        .unwrap();
        let interval = prepared.interval(Some(&json!(100))).unwrap();
        assert_eq!(prepared.duration(interval), Duration::from_millis(550));
        let (sender, mut receiver) = RdpInputSender::channel(8);
        let now = Instant::now();
        let mut gesture = TimedInput::new(
            prepared,
            interval,
            now,
            now + Duration::from_millis(INPUT_TIMEOUT_MS),
        );
        let mut expected_steps = vec![
            (0, vec![key(29, false, true)]),
            (
                100,
                "hello"
                    .chars()
                    .flat_map(|ch| {
                        [
                            FastPathInputEvent::UnicodeKeyboardEvent(
                                KeyboardFlags::empty(),
                                ch as u16,
                            ),
                            FastPathInputEvent::UnicodeKeyboardEvent(
                                KeyboardFlags::RELEASE,
                                ch as u16,
                            ),
                        ]
                    })
                    .collect(),
            ),
        ];
        expected_steps.extend([
            (150, vec![]),
            (250, vec![key(28, false, true)]),
            (300, vec![key(28, false, false)]),
            (400, vec![key(29, false, true), key(28, false, true)]),
            (450, vec![key(28, false, false), key(29, false, false)]),
            (550, vec![key(29, false, false)]),
        ]);
        for (millis, expected) in expected_steps {
            if millis > 0 {
                assert!(
                    !gesture
                        .advance(&sender, now + Duration::from_millis(millis - 1))
                        .unwrap()
                );
                assert!(receiver.try_recv().is_err());
            }
            assert_eq!(
                gesture
                    .advance(&sender, now + Duration::from_millis(millis))
                    .unwrap(),
                millis == 550
            );
            if expected.is_empty() {
                assert!(receiver.try_recv().is_err());
            } else {
                assert_eq!(&queued(&mut receiver)[..], &expected);
            }
        }
    }
    #[test]
    fn text_chunks_preserve_unicode_and_wait_after_the_last_burst() {
        let text = "1234567🐟abcdefgh中";
        let prepared = batch(
            &json!([{"type":"text","text":text}, {"type":"press","key":"ENTER"}]),
            100,
            80,
        )
        .unwrap();
        let now = Instant::now();
        let mut gesture = TimedInput::new(
            prepared,
            Duration::ZERO,
            now,
            now + Duration::from_secs(300),
        );
        let (sender, mut receiver) = RdpInputSender::channel(1);
        let mut units = Vec::new();
        for (index, chunk) in text.chars().collect::<Vec<_>>().chunks(8).enumerate() {
            let tick = now + Duration::from_millis(index as u64 * 50);
            assert!(!gesture.advance(&sender, tick).unwrap());
            let events = queued(&mut receiver);
            let mut downs = Vec::new();
            let mut ups = Vec::new();
            for event in events {
                match event {
                    FastPathInputEvent::UnicodeKeyboardEvent(flags, unit) if flags.is_empty() => {
                        downs.push(unit)
                    }
                    FastPathInputEvent::UnicodeKeyboardEvent(flags, unit)
                        if flags == KeyboardFlags::RELEASE =>
                    {
                        ups.push(unit)
                    }
                    other => panic!("unexpected input: {other:?}"),
                }
            }
            assert_eq!(
                downs,
                chunk
                    .iter()
                    .collect::<String>()
                    .encode_utf16()
                    .collect::<Vec<_>>()
            );
            assert_eq!(downs, ups);
            units.extend(downs);
            assert!(
                !gesture
                    .advance(&sender, tick + Duration::from_millis(49))
                    .unwrap()
            );
            assert!(receiver.try_recv().is_err());
        }
        assert_eq!(units, text.encode_utf16().collect::<Vec<_>>());
        // At 150 ms the text has settled. Enter cannot be queued before that point.
        assert!(
            !gesture
                .advance(&sender, now + Duration::from_millis(150))
                .unwrap()
        );
        assert!(receiver.try_recv().is_err());
        assert!(
            !gesture
                .advance(&sender, now + Duration::from_millis(150))
                .unwrap()
        );
        assert_eq!(&queued(&mut receiver)[..], &[key(28, false, true)]);
        assert!(
            gesture
                .advance(&sender, now + Duration::from_millis(200))
                .unwrap()
        );
        assert_eq!(&queued(&mut receiver)[..], &[key(28, false, false)]);
    }

    #[test]
    fn long_input_survives_old_time_limits_and_delayed_ticks_within_its_deadline() {
        let mut actions = vec![json!({"type":"move","x":1,"y":1}); 61];
        for _ in 0..3 {
            actions.push(json!({"type":"text","text":"0123456789".repeat(330)}));
        }
        let prepared = batch(&json!(actions), 100, 80).unwrap();
        let interval = prepared.interval(Some(&json!(1000))).unwrap();
        assert!(prepared.duration(interval) > Duration::from_secs(120));
        assert!(prepared.duration(interval) < Duration::from_secs(150));
        let expected = prepared.events.clone();
        let now = Instant::now();
        let mut gesture = TimedInput::new(
            prepared,
            interval,
            now,
            now + Duration::from_millis(INPUT_TIMEOUT_MS),
        );
        let (sender, mut receiver) = RdpInputSender::channel(1);
        let mut actual = Vec::new();
        loop {
            // Every tick is late: the scheduler must keep real pauses without timing out at 5/30 seconds.
            let done = gesture
                .advance(&sender, gesture.next_at + Duration::from_millis(50))
                .unwrap();
            while let Ok(RdpInputEvent::FastPath(events)) = receiver.try_recv() {
                actual.extend(events);
            }
            if done {
                break;
            }
        }
        assert_eq!(&actual[..], &expected[..]);
    }

    #[test]
    fn an_expired_input_deadline_stops_only_unsent_steps_without_releasing_held_keys() {
        let prepared = batch(
            &json!([
                {"type":"key","code":29,"down":true},
                {"type":"text","text":"must not be sent"}
            ]),
            100,
            80,
        )
        .unwrap();
        let now = Instant::now();
        let mut gesture = TimedInput::new(
            prepared,
            Duration::from_secs(1),
            now,
            now + Duration::from_millis(500),
        );
        let (sender, mut receiver) = RdpInputSender::channel(1);
        assert!(!gesture.advance(&sender, now).unwrap());
        assert_eq!(&queued(&mut receiver)[..], &[key(29, false, true)]);
        assert_eq!(
            gesture
                .advance(&sender, now + Duration::from_millis(500))
                .unwrap_err()
                .to_string(),
            "RDP_INPUT_TIMEOUT"
        );
        drop(gesture);
        assert!(receiver.try_recv().is_err());
        assert!(
            sender
                .try_send(RdpInputEvent::FastPath(
                    [key(29, false, false)].into_iter().collect()
                ))
                .is_ok()
        );
        assert_eq!(&queued(&mut receiver)[..], &[key(29, false, false)]);
    }

    #[test]
    fn text_limits_apply_to_characters_and_the_serialized_complete_sequence() {
        let long = batch(&json!([{"type":"text","text":"A".repeat(4096)}]), 100, 80).unwrap();
        assert_eq!(long.events.len(), 8192);
        assert!(batch(&json!([{"type":"text","text":"🐟".repeat(2048)}]), 100, 80).is_ok());
        for text in [
            String::new(),
            "A".repeat(4097),
            "中".repeat(4096),
            "\0".repeat(2000),
        ] {
            assert!(batch(&json!([{"type":"text","text":text}]), 100, 80).is_err());
        }
        assert!(
            batch(
                &json!(vec![json!({"type":"text","text":"A".repeat(4000)}); 3]),
                100,
                80
            )
            .is_err()
        );
        for action in [
            json!({"type":"text","text":null}),
            json!({"type":"text","text":"valid","extra":true}),
        ] {
            assert!(batch(&json!([{"type":"press","key":"A"},action]), 100, 80).is_err());
        }
    }
    #[test]
    fn intervals_are_optional_and_bounded_before_any_dispatch() {
        let pair = batch(
            &json!([{"type":"key","code":56,"down":true},{"type":"key","code":56,"down":false}]),
            100,
            80,
        )
        .unwrap();
        assert_eq!(pair.interval(None).unwrap(), Duration::from_millis(50));
        assert_eq!(pair.interval(Some(&json!(0))).unwrap(), Duration::ZERO);
        assert_eq!(
            pair.interval(Some(&json!(80))).unwrap(),
            Duration::from_millis(80)
        );
        for value in [
            json!(null),
            json!(-1),
            json!(1.5),
            json!("80"),
            json!(true),
            json!(1001),
        ] {
            assert!(pair.interval(Some(&value)).is_err());
        }
        let many = batch(
            &json!(vec![json!({"type":"move","x":1,"y":1}); 64]),
            100,
            80,
        )
        .unwrap();
        assert!(many.interval(Some(&json!(1000))).is_ok());
        assert!(many.interval(Some(&json!(50))).is_ok());
    }
    #[test]
    fn double_alt_keeps_real_intervals_and_never_catches_up_in_a_burst() {
        let (sender, mut receiver) = RdpInputSender::channel(8);
        let prepared = batch(
            &json!([
                {"type":"key","code":56,"down":true},{"type":"key","code":56,"down":false},
                {"type":"key","code":56,"down":true},{"type":"key","code":56,"down":false}
            ]),
            100,
            80,
        )
        .unwrap();
        let now = Instant::now();
        let interval = Duration::from_millis(80);
        let mut gesture = TimedInput::new(
            prepared,
            interval,
            now,
            now + Duration::from_millis(INPUT_TIMEOUT_MS),
        );
        assert!(!gesture.advance(&sender, now).unwrap());
        assert_eq!(&queued(&mut receiver)[..], &[key(56, false, true)]);
        assert!(
            !gesture
                .advance(&sender, now + Duration::from_millis(79))
                .unwrap()
        );
        assert!(receiver.try_recv().is_err());
        let late = now + Duration::from_millis(200);
        assert!(!gesture.advance(&sender, late).unwrap());
        assert_eq!(&queued(&mut receiver)[..], &[key(56, false, false)]);
        assert!(!gesture.advance(&sender, late).unwrap());
        assert!(receiver.try_recv().is_err());
        assert!(!gesture.advance(&sender, late + interval).unwrap());
        assert_eq!(&queued(&mut receiver)[..], &[key(56, false, true)]);
        assert!(gesture.advance(&sender, late + interval * 2).unwrap());
        assert_eq!(&queued(&mut receiver)[..], &[key(56, false, false)]);
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn partial_send_failure_adds_no_release_or_other_unrequested_events() {
        let (sender, mut receiver) = RdpInputSender::channel(1);
        let prepared = batch(
            &json!([
                {"type":"key","code":29,"down":true},
                {"type":"press","key":"A"}
            ]),
            100,
            80,
        )
        .unwrap();
        let now = Instant::now();
        let interval = Duration::from_millis(50);
        let mut gesture = TimedInput::new(
            prepared,
            interval,
            now,
            now + Duration::from_millis(INPUT_TIMEOUT_MS),
        );
        assert!(!gesture.advance(&sender, now).unwrap());
        assert!(gesture.advance(&sender, now + interval).is_err());
        assert_eq!(&queued(&mut receiver)[..], &[key(29, false, true)]);
        drop(gesture);
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn independent_calls_send_exact_key_actions_without_protecting_prior_holds() {
        let (sender, mut receiver) = RdpInputSender::channel(8);
        let now = Instant::now();
        let calls = [
            json!([{"type":"key","code":29,"down":true}]),
            json!([{"type":"press","key":"A"}]),
            json!([{"type":"hotkey","keys":["CTRL","A"]}]),
            json!([{"type":"key","code":29,"down":false}]),
        ];
        let mut sent = Events::new();
        for actions in calls {
            let prepared = batch(&actions, 100, 80).unwrap();
            let interval = prepared.interval(None).unwrap();
            let mut gesture = TimedInput::new(
                prepared,
                interval,
                now,
                now + Duration::from_millis(INPUT_TIMEOUT_MS),
            );
            loop {
                let done = gesture.advance(&sender, gesture.next_at).unwrap();
                sent.extend(queued(&mut receiver));
                if done {
                    break;
                }
            }
            drop(gesture);
            assert!(receiver.try_recv().is_err());
        }
        assert_eq!(
            &sent[..],
            &[
                key(29, false, true),
                key(30, false, true),
                key(30, false, false),
                key(29, false, true),
                key(30, false, true),
                key(30, false, false),
                key(29, false, false),
                key(29, false, false),
            ]
        );
    }
    #[test]
    fn separate_named_presses_hold_then_wait_between_actions() {
        let prepared = batch(
            &json!([{"type":"press","key":"ALT"},{"type":"press","key":"ALT"}]),
            100,
            80,
        )
        .unwrap();
        let interval = prepared.interval(Some(&json!(80))).unwrap();
        assert_eq!(prepared.duration(interval), Duration::from_millis(180));
        let (sender, mut receiver) = RdpInputSender::channel(4);
        let now = Instant::now();
        let mut gesture = TimedInput::new(
            prepared,
            interval,
            now,
            now + Duration::from_millis(INPUT_TIMEOUT_MS),
        );
        for (millis, down, done) in [
            (0, true, false),
            (50, false, false),
            (130, true, false),
            (180, false, true),
        ] {
            assert_eq!(
                gesture
                    .advance(&sender, now + Duration::from_millis(millis))
                    .unwrap(),
                done
            );
            assert_eq!(&queued(&mut receiver)[..], &[key(56, false, down)]);
        }
    }
    #[test]
    fn chords_hold_together_release_in_reverse_and_keep_action_spacing_separate() {
        let prepared = batch(
            &json!([
                {"type":"hotkey","keys":["CTRL","A"]},
                {"type":"press","key":"ENTER"}
            ]),
            100,
            80,
        )
        .unwrap();
        let interval = prepared.interval(Some(&json!(100))).unwrap();
        assert_eq!(prepared.duration(interval), Duration::from_millis(200));
        let (sender, mut receiver) = RdpInputSender::channel(4);
        let now = Instant::now();
        let mut gesture = TimedInput::new(
            prepared,
            interval,
            now,
            now + Duration::from_millis(INPUT_TIMEOUT_MS),
        );
        gesture.advance(&sender, now).unwrap();
        assert_eq!(
            &queued(&mut receiver)[..],
            &[key(29, false, true), key(30, false, true)]
        );
        gesture
            .advance(&sender, now + Duration::from_millis(50))
            .unwrap();
        assert_eq!(
            &queued(&mut receiver)[..],
            &[key(30, false, false), key(29, false, false)]
        );
        gesture
            .advance(&sender, now + Duration::from_millis(149))
            .unwrap();
        assert!(receiver.try_recv().is_err());
        gesture
            .advance(&sender, now + Duration::from_millis(150))
            .unwrap();
        assert_eq!(&queued(&mut receiver)[..], &[key(28, false, true)]);
        assert!(
            gesture
                .advance(&sender, now + Duration::from_millis(200))
                .unwrap()
        );
        assert_eq!(&queued(&mut receiver)[..], &[key(28, false, false)]);
        let zero = batch(&json!([{"type":"hotkey","keys":["CTRL","A"]}]), 100, 80).unwrap();
        assert_eq!(
            zero.duration(zero.interval(Some(&json!(0))).unwrap()),
            Duration::from_millis(50)
        );
    }
    #[test]
    fn named_input_validates_the_whole_gesture_and_all_waits_before_dispatch() {
        for value in [
            json!([{"type":"press","key":"not-a-key"}]),
            json!([{"type":"hotkey","keys":["CTRL"]}]),
            json!([{"type":"hotkey","keys":["CTRL","ControlLeft"]}]),
            json!([{"type":"press","key":"A"},{"type":"hotkey","keys":["CTRL","中文"]}]),
        ] {
            assert!(batch(&value, 100, 80).is_err());
        }
        let excessive = batch(
            &json!(vec![json!({"type":"press","key":"ALT"}); 5]),
            100,
            80,
        )
        .unwrap();
        assert_eq!(
            excessive.duration(excessive.interval(Some(&json!(1000))).unwrap()),
            Duration::from_millis(4250)
        );
        let right_alt = batch(&json!([{"type":"press","key":"AltRight"}]), 100, 80).unwrap();
        assert_eq!(
            &right_alt.events[..],
            &[key(56, true, true), key(56, true, false)]
        );
    }
    #[test]
    fn keyboard_steps_do_not_restore_an_earlier_mouse_position() {
        let prepared = batch(
            &json!([
                {"type":"move","x":10,"y":12},
                {"type":"press","key":"SHIFT"}
            ]),
            100,
            80,
        )
        .unwrap();
        let interval = prepared.interval(None).unwrap();
        let (sender, mut receiver) = RdpInputSender::channel(3);
        let now = Instant::now();
        let mut gesture = TimedInput::new(
            prepared,
            interval,
            now,
            now + Duration::from_millis(INPUT_TIMEOUT_MS),
        );
        assert!(!gesture.advance(&sender, now).unwrap());
        queued(&mut receiver);
        assert_eq!(gesture.position(), Some((10, 12)));
        assert!(!gesture.advance(&sender, now + interval).unwrap());
        queued(&mut receiver);
        assert_eq!(gesture.position(), None);
        assert!(gesture.advance(&sender, now + interval * 2).unwrap());
        queued(&mut receiver);
        assert_eq!(gesture.position(), None);
    }
    #[test]
    fn raw_key_and_mouse_actions_are_not_implicitly_completed() {
        let got = batch(
            &json!([
                {"type":"key","code":29,"down":true},
                {"type":"key","code":30,"down":true},
                {"type":"button","x":2,"y":3,"button":"left","down":true},
                {"type":"move","x":30,"y":40}
            ]),
            100,
            80,
        )
        .unwrap();
        assert_eq!(got.position, Some((30, 40)));
        assert_eq!(
            &got.events[..],
            &[
                key(29, false, true),
                key(30, false, true),
                mouse(2, 3, 0x9000, 0),
                mouse(30, 40, 0x0800, 0),
            ]
        );
    }
    #[test]
    fn reject_invalid_complete_batch_and_limits() {
        for value in [
            json!([]),
            json!([{"type":"key","code":0,"down":true}]),
            json!([{"type":"move","x":100,"y":0}]),
            json!([{"type":"move","x":1,"y":1},{"type":"key","code":30,"down":true,"extra":1}]),
            json!([{"type":"wheel","x":0,"y":0,"delta":300}]),
            json!([{"type":"key","code":30,"down":"yes"}]),
            json!(vec![json!({"type":"move","x":0,"y":0}); 65]),
        ] {
            assert!(batch(&value, 100, 80).is_err(), "{value}");
        }
    }
    #[test]
    fn explicit_releases_and_extended_keys_are_preserved() {
        let got = batch(
            &json!([
                {"type":"key","code":83,"extended":true,"down":true},
                {"type":"key","code":83,"extended":true,"down":false},
                {"type":"wheel","x":0,"y":0,"delta":-120}
            ]),
            100,
            80,
        )
        .unwrap();
        assert_eq!(
            &got.events[..],
            &[
                key(83, true, true),
                key(83, true, false),
                mouse(0, 0, 0x0200, -120)
            ]
        );
    }
}
