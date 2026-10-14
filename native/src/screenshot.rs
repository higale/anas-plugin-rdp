use anyhow::{Context, bail};
use base64::Engine;
use serde_json::Value;

const MAX_PNG_BYTES: usize = 25 * 1024 * 1024;

pub struct Capture {
    pub width: u32,
    pub height: u32,
    pub data: String,
    pub cursor_drawn: bool,
}

pub(crate) fn cursor_pixels(cursor: &Value) -> anyhow::Result<(u32, u32, i64, i64, Vec<u8>)> {
    if cursor["kind"] == "default" {
        // A deterministic arrow, independent of the local operating system.
        let rows = [
            "#           ",
            "##          ",
            "#.#         ",
            "#..#        ",
            "#...#       ",
            "#....#      ",
            "#.....#     ",
            "#......#    ",
            "#.......#   ",
            "#........#  ",
            "#.....##### ",
            "#..#..#     ",
            "#.# #..#    ",
            "##  #..#    ",
            "#    #..#   ",
            "     ####   ",
        ];
        let pixels = rows
            .iter()
            .flat_map(|row| row.bytes())
            .flat_map(|pixel| match pixel {
                b'#' => [0, 0, 0, 255],
                b'.' => [255, 255, 255, 255],
                _ => [0, 0, 0, 0],
            })
            .collect();
        return Ok((12, 16, 0, 0, pixels));
    }
    let width = cursor["width"].as_u64().context("invalid cursor width")?;
    let height = cursor["height"].as_u64().context("invalid cursor height")?;
    if width == 0 || height == 0 || width > 512 || height > 512 {
        bail!("invalid cursor dimensions");
    }
    let pixels: Vec<u8> = serde_json::from_value(cursor["pixels"].clone())?;
    if pixels.len() != (width * height * 4) as usize {
        bail!("invalid cursor pixels");
    }
    Ok((
        width as u32,
        height as u32,
        cursor["x"].as_i64().unwrap_or(0),
        cursor["y"].as_i64().unwrap_or(0),
        pixels,
    ))
}

pub fn capture(
    image: &[u8],
    cursor: &Value,
    position: Option<(u16, u16)>,
    include_cursor: bool,
) -> anyhow::Result<Capture> {
    if image.len() < 8 {
        bail!("RDP_FRAME_UNAVAILABLE");
    }
    let width = u32::from_le_bytes(image[..4].try_into()?);
    let height = u32::from_le_bytes(image[4..8].try_into()?);
    let count = u64::from(width) * u64::from(height);
    if count == 0 || count > 16 * 1024 * 1024 || image.len() != 8 + count as usize * 4 {
        bail!("invalid desktop frame");
    }
    let mut pixels = image[8..].to_vec();
    let mut cursor_drawn = false;
    if include_cursor
        && cursor["kind"] != "hidden"
        && let Some((x, y)) = position
    {
        let (cw, ch, hx, hy, pointer) = cursor_pixels(cursor)?;
        for row in 0..ch {
            for col in 0..cw {
                let px = i64::from(x) - hx + i64::from(col);
                let py = i64::from(y) - hy + i64::from(row);
                if px < 0 || py < 0 || px >= i64::from(width) || py >= i64::from(height) {
                    continue;
                }
                let source = ((row * cw + col) * 4) as usize;
                let target = ((py as u32 * width + px as u32) * 4) as usize;
                let alpha = u32::from(pointer[source + 3]);
                for channel in 0..3 {
                    pixels[target + channel] = ((u32::from(pointer[source + channel]) * alpha
                        + u32::from(pixels[target + channel]) * (255 - alpha)
                        + 127)
                        / 255) as u8;
                }
            }
        }
        cursor_drawn = true;
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder.write_header()?.write_image_data(&pixels)?;
    }
    if bytes.len() > MAX_PNG_BYTES {
        bail!("RDP_SCREENSHOT_TOO_LARGE");
    }
    Ok(Capture {
        width,
        height,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        cursor_drawn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn image() -> Vec<u8> {
        [
            2u32.to_le_bytes().as_slice(),
            1u32.to_le_bytes().as_slice(),
            &[255, 255, 255, 255, 255, 255, 255, 255],
        ]
        .concat()
    }
    fn pixels(capture: &Capture) -> Vec<u8> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&capture.data)
            .unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut output = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut output).unwrap();
        output.truncate(info.buffer_size());
        output
    }
    #[test]
    fn original_frame_is_encoded_when_cursor_is_hidden_unknown_or_excluded() {
        for (cursor, position, include) in [
            (json!({"kind":"hidden"}), Some((0, 0)), true),
            (json!({"kind":"default"}), None, true),
            (json!({"kind":"default"}), Some((0, 0)), false),
        ] {
            let shot = capture(&image(), &cursor, position, include).unwrap();
            assert_eq!((shot.width, shot.height), (2, 1));
            assert!(!shot.cursor_drawn);
            assert_eq!(pixels(&shot), image()[8..]);
        }
    }
    #[test]
    fn cursor_uses_hotspot_alpha_and_edge_clipping_without_mutating_frame() {
        let original = image();
        let cursor = json!({"kind":"bitmap","width":2,"height":1,"x":1,"y":0,
            "pixels":[0,0,0,255,255,0,0,128]});
        let shot = capture(&original, &cursor, Some((0, 0)), true).unwrap();
        assert!(shot.cursor_drawn);
        assert_eq!(pixels(&shot), [255, 127, 127, 255, 255, 255, 255, 255]);
        assert_eq!(original, image());
    }
    #[test]
    fn default_cursor_and_invalid_frames_have_deterministic_results() {
        let shot = capture(&image(), &json!({"kind":"default"}), Some((0, 0)), true).unwrap();
        assert_eq!(pixels(&shot)[..4], [0, 0, 0, 255]);
        assert!(capture(&[], &Value::Null, None, false).is_err());
        assert!(capture(&[255; 16], &Value::Null, None, false).is_err());
    }
}
