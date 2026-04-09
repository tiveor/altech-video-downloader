<div align="center">

<img src="icons/icon128.png" alt="Altech Video Downloader" width="128" height="128">

# Altech Video Downloader

A Chrome extension that detects and downloads videos from web pages, with full support for HLS streaming to MP4 conversion.

[![Chrome Manifest V3](https://img.shields.io/badge/Manifest-V3-0f3460?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Version](https://img.shields.io/badge/version-1.2.0-00BCD4?style=flat-square)](https://github.com/tiveor/altech-video-downloader/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/tiveor/altech-video-downloader?style=flat-square&color=00BCD4)](https://github.com/tiveor/altech-video-downloader/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/tiveor/altech-video-downloader?style=flat-square)](https://github.com/tiveor/altech-video-downloader/issues)

</div>

---

## Features

- **Automatic video detection** — Intercepts video requests in real-time as you browse
- **HLS stream support** — Downloads `.m3u8` streams and converts them to VLC-compatible MP4 files
- **Direct video downloads** — Supports MP4, WebM, OGG, AVI, MOV, MKV, FLV, WMV, and M4V
- **Master playlist handling** — Automatically resolves HLS master playlists and groups variant streams
- **DOM scanning** — Finds videos via `<video>` tags, `<source>` elements, `<a>` links, and Open Graph meta tags
- **Dynamic detection** — Watches for dynamically added video elements via MutationObserver
- **Download progress** — Real-time progress bar for HLS segment fetching and muxing
- **Dark UI** — Clean, minimal popup interface

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│  Web Page   │────>│  Background  │────>│   Popup UI    │
│             │     │  Service     │     │               │
│ ┌─────────┐ │     │  Worker      │     │  List videos  │
│ │ <video> │ │     │              │     │  Download btn │
│ └─────────┘ │     │ ┌──────────┐ │     └───────┬───────┘
│             │     │ │ Network  │ │             │
│ .m3u8  .mp4 │     │ │ Monitor  │ │             ▼
│ .ts    .webm│     │ └──────────┘ │     ┌───────────────┐
└─────────────┘     └──────────────┘     │   Offscreen   │
                                         │   Document    │
      ┌──────────────┐                   │               │
      │Content Script│                   │ Fetch .ts     │
      │              │                   │ Mux to MP4    │
      │ DOM Scanner  │                   │ Download      │
      │ Mutation Obs │                   └───────────────┘
      └──────────────┘
```

1. **Network interception** — The background service worker monitors all HTTP responses for video MIME types and file extensions
2. **Content script** — Scans the DOM for `<video>` elements and observes mutations for dynamically loaded videos
3. **HLS processing** — An offscreen document fetches all `.ts` segments, defragments them using [mux.js](https://github.com/videojs/mux.js), and builds a proper MP4 container with correct `ftyp`, `moov`, and `mdat` atoms
4. **Badge counter** — The extension icon shows a badge with the number of detected videos on the current tab

## Installation

### From source (developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/tiveor/altech-video-downloader.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the cloned folder
5. The extension icon will appear in your toolbar

### Build for distribution

```bash
bash scripts/build.sh
```

This generates a `altech-video-downloader-v{version}.zip` ready to upload to the Chrome Web Store or share.

## Usage

1. Navigate to any page with video content
2. Click the extension icon — detected videos will appear in the popup
3. Click **Scan** to manually search the page DOM for additional videos
4. Click the download button next to any video:
   - **Direct videos** — Downloads immediately
   - **HLS streams** — Fetches all segments, muxes to MP4, then downloads

## Supported Formats

| Type | Extensions / Protocols | Download Method |
|------|----------------------|-----------------|
| Direct video | `.mp4` `.webm` `.ogg` `.avi` `.mov` `.mkv` `.flv` `.wmv` `.m4v` | Direct download |
| HLS streams | `.m3u8` + `.ts` segments | Fetch + mux to MP4 |

## Project Structure

```
altech-video-downloader/
├── manifest.json       # Extension manifest (Manifest V3)
├── background.js       # Service worker: network interception, message routing
├── content.js          # Content script: DOM scanning, mutation observer
├── popup.html          # Extension popup UI
├── popup.css           # Popup styles (dark theme)
├── popup.js            # Popup logic: rendering, download triggers
├── offscreen.html      # Offscreen document for HLS processing
├── offscreen.js        # HLS segment fetching, muxing, MP4 container building
├── icons/              # Extension icons (16, 48, 128px)
├── lib/
│   └── mux.min.js      # mux.js library for TS demuxing
└── scripts/
    ├── build.sh         # Build script for Chrome Web Store packaging
    └── generate-icons.sh # Icon generation from SVG source
```

## Permissions

| Permission | Why |
|------------|-----|
| `activeTab` | Access the current tab to scan for videos |
| `scripting` | Inject the DOM scanner into pages |
| `downloads` | Trigger file downloads |
| `webRequest` | Intercept network requests to detect video streams |
| `storage` | Store extension state |
| `offscreen` | Create offscreen document for HLS processing |
| `<all_urls>` | Monitor video requests on any website |

## Limitations

- Does not support DRM-protected content (Widevine, PlayReady)
- Does not support DASH/MPEG-DASH streams (`.mpd`)
- Cannot capture `blob:` or `data:` URLs generated by JavaScript players
- Some sites may block segment fetching due to CORS or authentication requirements

## Contributing

Contributions are welcome! Feel free to open an [issue](https://github.com/tiveor/altech-video-downloader/issues) or submit a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Credits

- [mux.js](https://github.com/videojs/mux.js) by Brightcove for TS demuxing
