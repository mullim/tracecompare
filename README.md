# TraceCompare

TraceCompare is an open-source workout analyzer for people who record the same activity on a watch, bike computer, phone, or external sensor. Load up to eight recordings and compare their telemetry on a shared timeline.

- Import FIT, TCX, GPX, or a previously exported TraceCompare ZIP.
- Overlay GPS routes, compare recorded distances, and inspect point-by-point separation.
- Compare heart rate, speed, distance, elevation, cadence, power, battery, and available FIT developer fields.
- Zoom two charts together, select a lap, adjust smoothing, and inspect a mean-max power curve.
- Align recordings by timestamp or use manual offsets and signal-based offset suggestions.
- Save a private set across devices and publish a revocable link when the deployment is connected to Supabase.

## Run locally

Use Node.js 22.12 or later.

```sh
npm ci
npm run dev
npm test
npm run build
```

The first visit opens a synthetic Garmin/Apple example. Import your own files to start a new comparison. The current working set is stored in this browser. Export a ZIP for a portable copy that includes the original files.

## Enable free accounts and sharing

1. Create a Supabase Free project. Run [the SQL migration](supabase/migrations/20261117000000_tracecompare.sql) once in its SQL editor or with the Supabase CLI. Apply it as the project's database owner.
2. Enable the [Google provider in Supabase Auth](https://supabase.com/docs/guides/auth/social-login/auth-google). Configure the Supabase callback URL in Google Cloud. In Supabase Auth, set the final app origin as the Site URL and allow the development URL if needed.
3. Copy `.env.example` to `.env.local` for local development. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to the project URL and browser-safe publishable key. Do not put a secret or service-role key in a Vite environment variable.
4. In [Cloudflare Pages](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/), connect the GitHub repository. Set the build command to `npm run build`, the output directory to `dist`, and the same two Vite variables in the build environment. You can use the supplied `pages.dev` address.
5. Verify sign-in, save a set, reopen it from another browser, publish a link, and open the link while signed out. Revoke it from Saved sets and confirm the old link is unavailable on reload.

The static app runs without any Supabase settings. Cloud accounts, cross-device storage, and links appear when the backend is configured. The app defaults to OpenFreeMap for map tiles. Set `VITE_MAP_STYLE` if you run a different MapLibre style server. Tiles are requested only while viewing a set that contains GPS data.

### Cloud limits and privacy

Private ZIP archives are capped at 5 MiB per set and published snapshots at 1 MiB. Each account can store up to 40 sets and 20 MiB, and the deployment allocates at most 300 MiB of logical storage for comparisons, charging a minimum of 16 KiB per stored object to leave room for metadata. This is an application-level cap in addition to the hosting provider's limits. Cloud quota exhaustion can interrupt storage and sharing, and local import, analysis, and export remain available.

The backend only exposes owner-scoped functions for private sets and an ID-based read function for published snapshots. Publishing strips original files, hidden recordings, native start timestamps, and FIT developer fields. The publish dialog requires a separate checkbox to include routes. Review the set title and any custom device labels before publishing. Revocation prevents future loads from the server. Someone who already downloaded or exported a snapshot can keep their copy.

## Comparison math

- All comparisons start with recorded UTC timestamps. Positive offsets move a recording later. Auto-align looks for correlation across power, speed, or cadence and asks before applying an offset.
- Bias is recording minus reference on paired samples. Mean absolute error measures magnitude, and coverage is the share of valid reference instants with a candidate observation. Missing time is approximate. See [the comparison functions](src/compare.ts) for tolerances and long-workout sampling.
- GPS separation is the great-circle distance between near-simultaneous points. It measures agreement between the two tracks. Summary values use the first visible comparison device and the selected reference.
- Distance uses the recorded cumulative distance when available and falls back to GPS segments for GPX or files without recorded distances.
- Laps and chart zoom change the displayed averages. Bias, error, and coverage use the full time overlap. Mean-max power excludes windows with missing readings.

This initial release supports manual imports and a 2D map. Automatic vendor sync, satellite imagery, 3D flyovers, and AI-written reports are outside this release.

## License

[MIT](LICENSE)
