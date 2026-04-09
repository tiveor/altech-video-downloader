# Changelog

All notable changes to Altech Video Downloader will be documented in this file.

## [1.2.1] - 2026-04-09

### Changed
- Moved `<all_urls>` from required `host_permissions` to `optional_host_permissions` for faster Chrome Web Store review
- Network interception now activates only after user grants permission via popup banner
- Extension still works without host permission using manual Scan + DOM detection

### Added
- Permission request banner in popup for first-time users
- `PRIVACY.md` privacy policy
- `CHANGELOG.md`

## [1.2.0] - 2026-04-08

### Changed
- Rebranded accent color from red to teal (#00BCD4) to differentiate from YouTube
- Updated all icons, popup UI, badge color, and progress bar to teal theme

### Added
- README with badges, architecture diagram, and contributing guide
- MIT License
- Build script (`scripts/build.sh`) for Chrome Web Store packaging
- Icon generation script (`scripts/generate-icons.sh`)
- `.gitignore` for build artifacts

### Fixed
- Fully working HLS to VLC-compatible MP4 conversion
- Correct `ftyp`, `moov`, and `mdat` atom construction

## [1.1.3] - 2026-04-07

### Fixed
- `ftypSize` off-by-8 error: `buildFtyp()` produces 32 bytes not 24

## [1.1.1] - 2026-04-07

### Fixed
- `stco` chunk offsets in defragmenter
- `stco` offsets: `trun data_offset` is relative to `moof`, not `mdat`

## [1.1.0] - 2026-04-07

### Added
- HLS stream grouping and MP4 muxing via mux.js
- Real-time progress UI for HLS downloads
- Master playlist detection and variant stream deduplication

### Changed
- Replaced broken `toMp4.js` with custom fMP4 defragmenter
- Replaced `mp4box.js` with `toMp4.js` for correct fMP4 defragmentation

### Fixed
- Audio-only stream detection
- MP4 duration patching for `mvhd`/`tkhd`/`mdhd` boxes
- Timestamp alignment following hls.js mp4-remuxer approach

## [1.0.0] - 2026-04-06

### Added
- Initial release
- Video detection via network request interception
- DOM scanning for `<video>` elements, `<source>`, `<a>` links, and Open Graph meta tags
- Direct video download support (MP4, WebM, OGG, AVI, MOV, MKV, FLV, WMV, M4V)
- Dynamic detection via MutationObserver
- Dark-themed popup UI with badge counter

[1.2.1]: https://github.com/tiveor/altech-video-downloader/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/tiveor/altech-video-downloader/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/tiveor/altech-video-downloader/compare/v1.1.1...v1.1.3
[1.1.1]: https://github.com/tiveor/altech-video-downloader/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/tiveor/altech-video-downloader/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tiveor/altech-video-downloader/releases/tag/v1.0.0
