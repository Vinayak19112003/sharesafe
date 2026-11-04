# ShareSafe

ShareSafe is a video review app for people who need to share visual evidence while covering a specific private detail. For example, a seller can cover a shipping label while leaving damage on the same parcel visible.

## Public judge demo

[Open the sample-only judge demo](https://sharesafe-judge-demo.lovable.app/). It runs in the browser with fictional footage and illustrative tracking data, independently of the private server and its password.

The standalone frontend lives in [`judge-demo/`](judge-demo/) and was imported from the [Lovable-derived demo source repository](https://github.com/Vinayak19112003/sharesafe-judge-demo-8c6e0b26). Run its own build and tests from that directory.

## Run locally

Install Node.js 22 or newer and FFmpeg with `ffprobe` and `libx264` available on your PATH. There are no npm dependencies to install.

```sh
npm start
```

Open http://127.0.0.1:3000. To use the app without a Meta key, upload a short clip and draw the covers manually.

## Review a clip

1. Upload an MP4 or MOV up to 15 seconds and 24 MiB. ShareSafe creates a silent, 12 fps review copy with a maximum edge of 720 pixels. The editor and export use the same indexed frames.
2. Use **Draw cover** to drag an opaque rectangle over the target. Use **Mark clear** for a frame where there is nothing to hide. Enter a last frame number to apply an edit to a range. Verify that the same edit fits each frame in that range.
3. Move through gaps and uncertain matches with **Next review frame**. **Show original** toggles the source view. Review the areas that need to remain visible before checking the approval box.
4. Choose **Export silent MP4**. ShareSafe writes the opaque covers into the actual video pixels and strips audio and source metadata. The download contains the reviewed 12 fps version.
5. Use **Delete clip** to clear the server copy. Jobs also expire after 30 minutes of inactivity, checked once per minute.

## Enable Meta analysis

Copy `.env.example` to `.env`, set `META_MODEL_API_KEY` locally and restart the app. The key stays on the server. With the key configured, open **Live Meta analysis** and choose whether to send the footage to Meta. Use staged footage when presenting the project.

- **Muse Spark 1.3** reads up to five sampled frames plus your instruction and suggests one object to hide and one to preserve. You can edit both descriptions. The preserve description stays visible as a review reminder.
- **SAM 3.1** tracks the hide target in the normalized video. ShareSafe reads the documented source-frame indices and bounding boxes and adds a margin before applying a solid cover. Missing frames, frames with multiple candidates, and low-confidence matches require a review decision. The live integration handles one tracked target per clip. Human review is required because a confident match can still cover the wrong object or miss private pixels.
- Manual mode requires neither a Meta key nor a network call to Meta. A consent checkbox gates both live actions. The app uses temporary local files and sends Meta requests only from the server.

## Run with Docker

```sh
docker build -t sharesafe .
docker run --rm -p 127.0.0.1:3000:3000 sharesafe
```

For an HTTPS demo hosted on Docker Agentic Platform, set a strong `SHARESAFE_DEMO_PASSWORD` in the server environment before opening the sandbox port. Open the HTTPS URL and enter the demo password on the ShareSafe sign-in page. Keep `META_MODEL_API_KEY` on the server and use the provider's host-scoped secret configuration when available. Live Meta mode requires the password when the app binds to a non-loopback address.

## Verify

```sh
npm test
```

The tests exercise stream parsing, the outbound Meta request shape with a mock, frame-index alignment, ambiguous matches, and export validation. A live run requires a valid key and an environment that can reach the Meta Model API.

The server binds to loopback by default. The editor is a single-operator prototype. Put any hosted instance behind authentication and TLS before using it with real footage. If the process is killed without shutdown, remove abandoned `sharesafe-*` directories from the system temp directory.
