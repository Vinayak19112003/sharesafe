# ShareSafe — Judge Demo

A standalone browser-only version of the ShareSafe redaction editor built in Lovable and packaged for independent hosting.

- [Open the judge demo](https://sharesafe-judge-demo.lovable.app)
- [Lovable project](https://lovable.dev/projects/b9f6ae0b-22db-4396-887a-627dd095db62)

The scene uses fictional shipping details and illustrative tracking data. It has no login, uploads, inference API, or backend. Review the prepared tracking, correct the missed cover, then export a silent video locally. MP4 and WebM availability depends on the browser.

```sh
npm install
npm test
npm run build
```

Serve the contents of `dist/` with any static host.
